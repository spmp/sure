# A named rearrangement of a family's categories, made in the budget
# planner. A family can keep several; live categories don't change until
# one is applied.
#
# - `parents`: category id => new parent (category id, group key, or nil for
#   the top level). Categories not listed keep their parent.
# - `groups`: new top-level categories, [{ key, name, color, icon }].
# - `overrides`: category id => { name, color, icon } to change on apply.
#   Colour only applies to top-level categories; Sure gives subcategories
#   their parent's colour.
# - `removals`: category id => category id to move its transactions to, or
#   nil for a category with no transactions.
# - `excluded`: ids (or group keys, or "uncategorized") left out of the
#   planner's analysis. Never applied to live data.
#
# The result must keep Sure's two levels: a parent stays top-level.
class BudgetPlan < ApplicationRecord
  GROUP_KEY = /\Anew-[0-9a-f]{8,32}\z/
  COLOR = /\A#[0-9A-Fa-f]{6}\z/
  ICON = /\A[a-z0-9-]+\z/
  UNCATEGORIZED = "uncategorized".freeze

  class Stale < StandardError; end

  belongs_to :family
  belongs_to :updated_by, class_name: "User", optional: true

  before_validation :drop_unchanged_parents
  validates :name, presence: true, length: { maximum: 60 }
  validate :name_is_unique
  validate :tree_is_valid
  validate :appearance_is_valid
  validate :removals_are_valid
  validate :exclusions_are_valid

  # Changes whenever a category is added, removed, renamed or moved, so a
  # plan made before such a change can't be applied over it.
  def self.fingerprint(family)
    rows = family.categories.order(:id).pluck(:id, :parent_id, :name, :updated_at)
    Digest::MD5.hexdigest(rows.map { |row| row.join("|") }.join("\n"))
  end

  def self.start(family, name:, user:, copy_of: nil)
    attributes = copy_of&.slice(:parents, :groups, :overrides, :excluded, :removals) || {}
    family.budget_plans.create!(
      attributes.merge(name: name, updated_by: user,
                       categories_fingerprint: copy_of&.categories_fingerprint || fingerprint(family))
    )
  end

  def stale?
    categories_fingerprint != self.class.fingerprint(family)
  end

  def changes_categories?
    parents.any? || groups.any? || overrides.any? || removals.any?
  end

  # Returns { group key => created category id }.
  def apply!
    raise Stale if stale?

    transaction do
      ids = groups.to_h do |group|
        category = family.categories.create!(name: group["name"], color: group["color"], lucide_icon: group["icon"].presence || "folder")
        [ group["key"], category.id ]
      end

      move_categories!(ids)
      remove_categories!(ids)
      apply_overrides!

      ids
    end
  end

  def moved_category_ids
    moved_categories.map(&:id)
  end

  def removed_category_ids
    removals.keys
  end

  private
    def categories_by_id
      @categories_by_id ||= family.categories.index_by(&:id)
    end

    def group_keys
      groups.map { |group| group["key"] }
    end

    def moved_categories
      parents.filter_map do |id, parent|
        category = categories_by_id[id]
        category if category && category.parent_id != parent && !removals.key?(id)
      end
    end

    def effective_parent(id)
      parents.key?(id) ? parents[id] : categories_by_id[id]&.parent_id
    end

    def move_categories!(ids)
      moved = moved_categories
      # Detach first so a parent whose children leave can then be nested.
      moved.each { |category| category.update!(parent_id: nil) if category.parent_id }
      moved.each do |category|
        target = parents[category.id]
        category.reload.update!(parent_id: ids.fetch(target, target)) if target
      end
    end

    def remove_categories!(ids)
      removals.each do |id, target_id|
        source = family.categories.find(id)
        if target_id
          target = family.categories.find(ids.fetch(target_id, target_id))
          Category::Merger.new(family: family, target_category: target, source_categories: [ source ]).merge!
        else
          source.destroy!
        end
      end
    end

    def apply_overrides!
      overrides.each do |id, attributes|
        next if removals.key?(id)

        category = family.categories.find(id)
        changes = { name: attributes["name"], lucide_icon: attributes["icon"] }
        changes[:color] = attributes["color"] unless category.parent_id
        category.update!(changes.compact_blank)
      end
    end

    # Moving a category back where it was is no change.
    def drop_unchanged_parents
      self.parents = parents.reject { |id, parent| categories_by_id.key?(id) && categories_by_id[id].parent_id == parent }
    end

    def name_is_unique
      others = family.budget_plans.where.not(id: id).pluck(:name).map(&:downcase)
      errors.add(:name, :taken) if name.present? && others.include?(name.downcase)
    end

    def tree_is_valid
      keys = group_keys
      parents.each do |id, parent|
        unless categories_by_id.key?(id)
          errors.add(:parents, :unknown_category)
          next
        end
        next if parent.nil? || keys.include?(parent)

        if !categories_by_id.key?(parent) || parent == id || removals.key?(parent)
          errors.add(:parents, :unknown_parent)
        elsif effective_parent(parent)
          errors.add(:parents, :too_deep)
        end
      end

      kept = categories_by_id.keys - removals.keys
      parented = kept.select { |id| effective_parent(id) }
      if parented.any? { |id| kept.any? { |child| effective_parent(child) == id } }
        errors.add(:parents, :too_deep)
      end
    end

    def appearance_is_valid
      errors.add(:groups, :invalid_key) unless group_keys.all? { |key| key.to_s.match?(GROUP_KEY) }
      errors.add(:groups, :blank_name) if groups.any? { |group| group["name"].to_s.strip.blank? }
      errors.add(:groups, :invalid_color) unless groups.all? { |group| group["color"].to_s.match?(COLOR) }

      overrides.each do |id, attributes|
        errors.add(:overrides, :unknown_category) unless categories_by_id.key?(id)
        errors.add(:overrides, :blank_name) if attributes.key?("name") && attributes["name"].to_s.strip.blank?
        errors.add(:overrides, :invalid_color) if attributes["color"].present? && !attributes["color"].match?(COLOR)
        errors.add(:overrides, :invalid_icon) if attributes["icon"].present? && !attributes["icon"].match?(ICON)
      end

      errors.add(:base, :duplicate_name) if final_names.uniq.size != final_names.size
    end

    # Category names once the plan is applied, lowercased: names are unique
    # per family, ignoring case.
    def final_names
      kept = categories_by_id.values.reject { |category| removals.key?(category.id) }
      names = kept.map { |category| overrides.dig(category.id, "name").presence || category.name }
      (names + groups.map { |group| group["name"].to_s }).map { |name| name.strip.downcase }
    end

    def removals_are_valid
      removals.each do |id, target|
        unless categories_by_id.key?(id)
          errors.add(:removals, :unknown_category)
          next
        end

        has_children = categories_by_id.keys.any? { |child| child != id && !removals.key?(child) && effective_parent(child) == id }
        errors.add(:removals, :has_subcategories) if has_children

        if target.nil?
          errors.add(:removals, :has_transactions) if family.transactions.where(category_id: id).exists?
        elsif target == id || removals.key?(target) || !(categories_by_id.key?(target) || group_keys.include?(target))
          errors.add(:removals, :invalid_target)
        end
      end
    end

    def exclusions_are_valid
      allowed = categories_by_id.keys + group_keys + [ UNCATEGORIZED ]
      errors.add(:excluded, :unknown) unless excluded.is_a?(Array) && (excluded - allowed).empty?
    end
end
