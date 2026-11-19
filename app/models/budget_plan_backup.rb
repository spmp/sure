# The family's categories and one budget's amounts as they were just before
# the planner last applied a plan, so that apply can be undone. One per
# family: each apply replaces it.
#
# Restore puts back the name, parent, colour and icon of every captured
# category, and the budget's allocations, total and expected income.
# Categories created since are kept (they may hold transactions now).
# Categories deleted since (removed by a plan, or by hand) can't come back;
# everything else is restored and #restore! returns their names.
class BudgetPlanBackup < ApplicationRecord
  belongs_to :family
  belongs_to :budget, optional: true
  belongs_to :created_by, class_name: "User", optional: true

  def self.capture!(budget, user:)
    family = budget.family
    attributes = {
      budget: budget,
      created_by: user,
      categories: family.categories.reload.map { |c| c.slice(:id, :name, :parent_id, :color, :lucide_icon) },
      budget_categories: budget.budget_categories.reload.map { |bc| { "category_id" => bc.category_id, "budgeted_spending" => bc.budgeted_spending&.to_s } },
      budgeted_spending: budget.budgeted_spending,
      expected_income: budget.expected_income
    }

    transaction do
      backup = family.budget_plan_backup || family.build_budget_plan_backup
      backup.update!(attributes)
      backup
    end
  end

  # Returns the names of captured categories that no longer exist.
  def restore!
    current = family.categories.index_by(&:id)
    present, missing = categories.partition { |c| current.key?(c["id"]) }

    transaction do
      # Flatten first so any parent can take back its children.
      present.each { |c| current[c["id"]].update!(parent_id: nil) if current[c["id"]].parent_id }
      present.each do |c|
        parent_id = current.key?(c["parent_id"]) ? c["parent_id"] : nil
        current[c["id"]].reload.update!(c.slice("name", "color", "lucide_icon").merge("parent_id" => parent_id))
      end

      restore_budget! if budget
    end

    Budget::RolloverCalculator.new(family: family, user: budget.user).recompute! if budget
    missing.map { |c| c["name"] }
  end

  private
    def restore_budget!
      budget.sync_budget_categories
      rows = budget.budget_categories.reload.index_by(&:category_id)
      budget_categories.each do |saved|
        rows[saved["category_id"]]&.update!(budgeted_spending: saved["budgeted_spending"])
      end
      budget.update!(budgeted_spending: budgeted_spending, expected_income: expected_income)
    end
end
