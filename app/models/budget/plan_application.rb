# Writes amounts chosen in the planner to one budget: top-level category
# allocations, the budget total and expected income.
#
# Subcategories are left alone. One at zero already shares its parent's
# budget; one with its own amount is part of the parent's stored total, so
# the parent can't be set below the sum of those amounts.
#
# Uncategorized has no stored allocation: it is whatever the budget total
# leaves after the top-level allocations, so the total is set to their sum
# plus the Uncategorized amount. Top-level categories missing from the plan
# keep their allocation and still count towards the total.
class Budget::PlanApplication
  class Invalid < StandardError
    attr_reader :category_ids

    def initialize(reason, category_ids: [])
      @category_ids = category_ids
      super(I18n.t("budget_planners.plan_application.errors.#{reason}"))
    end
  end

  # What the planner starts from: the budget's current top-level amounts and
  # the least each can be set to, so the page can warn before submitting.
  def self.current_state(budget, user:)
    rows = budget.budget_categories.to_a
    parents = rows.reject(&:subcategory?)

    {
      editable: budget.editable_by?(user),
      initialized: budget.initialized?,
      budget_name: budget.name,
      amounts: parents.to_h { |bc| [ bc.category_id, (bc.budgeted_spending || 0).to_f ] },
      minimums: parents.to_h do |bc|
        own = rows.select { |child| child.category.parent_id == bc.category_id && !child.inherits_parent_budget? }
        [ bc.category_id, own.sum { |child| child.budgeted_spending || 0 }.to_f ]
      end,
      uncategorized: budget.initialized? ? [ budget.available_to_allocate, 0 ].max.to_f : nil,
      expected_income: budget.expected_income&.to_f
    }
  end

  def initialize(budget, categories:, uncategorized: 0, expected_income: nil)
    @budget = budget
    @amounts = categories.to_h { |id, amount| [ id.to_s, to_amount(amount) ] }
    @uncategorized = to_amount(uncategorized)
    @expected_income = expected_income.nil? ? nil : to_amount(expected_income)
  end

  def apply!
    validate_amounts!

    Budget.transaction do
      budget.lock!
      budget.sync_budget_categories
      rows = budget.budget_categories.reload.includes(:category).lock.to_a
      parents = rows.reject(&:subcategory?).index_by { |bc| bc.category_id.to_s }

      unknown = amounts.keys - parents.keys
      raise Invalid.new(:unknown_category) if unknown.any?

      too_low = amounts.filter_map do |id, amount|
        id if amount < ring_fenced_total(parents[id], rows)
      end
      raise Invalid.new(:below_subcategories, category_ids: too_low) if too_low.any?

      amounts.each { |id, amount| parents[id].update!(budgeted_spending: amount) }

      allocated = parents.values.sum { |bc| bc.budgeted_spending || 0 }
      attributes = { budgeted_spending: allocated + uncategorized }
      attributes[:expected_income] = expected_income unless expected_income.nil?
      budget.update!(attributes)
    end

    # After commit: the calculator takes an advisory lock, and taking it while
    # these row locks are held would invert the order BudgetCategoriesController
    # uses (see #move there).
    Budget::RolloverCalculator.new(family: budget.family, user: budget.user).recompute!
    budget
  end

  private
    attr_reader :budget, :amounts, :uncategorized, :expected_income

    def validate_amounts!
      values = amounts.values + [ uncategorized, expected_income ].compact
      raise Invalid.new(:invalid_amount) if values.any? { |v| v.nil? || v.negative? }
    end

    def ring_fenced_total(parent, rows)
      rows.select { |bc| bc.category.parent_id == parent.category_id && !bc.inherits_parent_budget? }
          .sum { |bc| bc.budgeted_spending || 0 }
    end

    def to_amount(value)
      BigDecimal(value.to_s)
    rescue ArgumentError, TypeError
      nil
    end
end
