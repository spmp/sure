# A family's unsaved rearrangement of its categories, made in the budget
# planner. Live categories don't change until the draft is applied.
#
# `parents` maps a category id to its new parent: a category id, a new
# group's key, or nil for the top level. Categories not listed keep their
# parent. `groups` are new top-level categories ({ key, name, color }).
# The result must keep Sure's two levels: a parent stays top-level.
class BudgetPlanDraft < ApplicationRecord
  GROUP_KEY = /\Anew-[0-9a-f]{8,32}\z/

  class Stale < StandardError; end

  belongs_to :family
  belongs_to :updated_by, class_name: "User", optional: true

  before_validation :drop_unchanged_parents
  validate :tree_is_valid

  # Changes whenever a category is added, removed, renamed or moved, so a
  # draft made before such a change can't be applied over it.
  def self.fingerprint(family)
    rows = family.categories.order(:id).pluck(:id, :parent_id, :name, :updated_at)
    Digest::MD5.hexdigest(rows.map { |row| row.join("|") }.join("\n"))
  end

  def stale?
    categories_fingerprint != self.class.fingerprint(family)
  end

  # Returns { group key => created category id }.
  def apply!
    raise Stale if stale?

    transaction do
      ids = groups.to_h do |group|
        category = family.categories.create!(name: group["name"], color: group["color"], lucide_icon: "folder")
        [ group["key"], category.id ]
      end

      moved = moved_categories
      # Detach first so a parent whose children leave can then be nested.
      moved.each { |category| category.update!(parent_id: nil) if category.parent_id }
      moved.each do |category|
        target = parents[category.id]
        category.reload.update!(parent_id: ids.fetch(target, target)) if target
      end

      ids
    end
  end

  def moved_category_ids
    moved_categories.map(&:id)
  end

  private
    # Moving a category back where it was is no change.
    def drop_unchanged_parents
      self.parents = parents.reject { |id, parent| categories_by_id.key?(id) && categories_by_id[id].parent_id == parent }
    end

    def categories_by_id
      @categories_by_id ||= family.categories.index_by(&:id)
    end

    def moved_categories
      parents.filter_map do |id, parent|
        category = categories_by_id[id]
        category if category && category.parent_id != parent
      end
    end

    def effective_parent(id)
      parents.key?(id) ? parents[id] : categories_by_id[id]&.parent_id
    end

    def tree_is_valid
      group_keys = groups.map { |group| group["key"] }
      validate_groups(group_keys)

      parents.each do |id, parent|
        unless categories_by_id.key?(id)
          errors.add(:parents, :unknown_category)
          next
        end
        next if parent.nil? || group_keys.include?(parent)

        if !categories_by_id.key?(parent) || parent == id
          errors.add(:parents, :unknown_parent)
        elsif effective_parent(parent)
          errors.add(:parents, :too_deep)
        end
      end

      parented = categories_by_id.keys.select { |id| effective_parent(id) }
      if parented.any? { |id| categories_by_id.keys.any? { |child| effective_parent(child) == id } }
        errors.add(:parents, :too_deep)
      end
    end

    def validate_groups(keys)
      names = groups.map { |group| group["name"].to_s.strip.downcase }
      existing = categories_by_id.values.map { |category| category.name.downcase }

      errors.add(:groups, :invalid_key) unless keys.all? { |key| key.to_s.match?(GROUP_KEY) }
      errors.add(:groups, :blank_name) if names.any?(&:blank?)
      errors.add(:groups, :duplicate_name) if names.uniq.size != names.size || names.intersect?(existing)
      errors.add(:groups, :invalid_color) unless groups.all? { |group| group["color"].to_s.match?(/\A#[0-9A-Fa-f]{6}\z/) }
    end
end
