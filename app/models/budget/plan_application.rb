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
#
# With a plan (BudgetPlan), its category changes are applied first, in the
# same transaction, and amounts may be keyed by a new group's key. A
# category the plan moves under a parent shares that parent's budget (its
# own amount becomes zero). The plan is deleted once applied: its changes
# are now the live categories.
# Every apply first replaces the family's BudgetPlanBackup.
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
      start_date: budget.start_date,
      amounts: parents.to_h { |bc| [ bc.category_id, (bc.budgeted_spending || 0).to_f ] },
      minimums: parents.to_h do |bc|
        own = rows.select { |child| child.category.parent_id == bc.category_id && !child.inherits_parent_budget? }
        [ bc.category_id, own.sum { |child| child.budgeted_spending || 0 }.to_f ]
      end,
      # Subcategories with their own amount; the rest share their parent's.
      own_amounts: rows.select(&:subcategory?).reject(&:inherits_parent_budget?)
                       .to_h { |bc| [ bc.category_id, bc.budgeted_spending.to_f ] },
      uncategorized: budget.initialized? ? [ budget.available_to_allocate, 0 ].max.to_f : nil,
      expected_income: budget.expected_income&.to_f
    }
  end

  def initialize(budget, categories:, uncategorized: 0, expected_income: nil, plan: nil, user: nil)
    @budget = budget
    @plan = plan
    @user = user
    @amounts = categories.to_h { |id, amount| [ id.to_s, to_amount(amount) ] }
    @uncategorized = to_amount(uncategorized)
    @expected_income = expected_income.nil? ? nil : to_amount(expected_income)
  end

  def apply!
    validate_amounts!

    Budget.transaction do
      budget.lock!
      BudgetPlanBackup.capture!(budget, user: user)
      moved_ids = apply_plan!
      # The plan's merges add and remove budget rows behind the association.
      budget.budget_categories.reset
      budget.sync_budget_categories
      rows = budget.budget_categories.reload.includes(:category).lock.to_a
      rows.each do |bc|
        bc.update!(budgeted_spending: 0) if moved_ids.include?(bc.category_id) && bc.subcategory?
      end
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
      plan&.destroy!
    end

    # After commit: the calculator takes an advisory lock, and taking it while
    # these row locks are held would invert the order BudgetCategoriesController
    # uses (see #move there).
    Budget::RolloverCalculator.new(family: budget.family, user: budget.user).recompute!
    budget
  end

  private
    attr_reader :budget, :amounts, :uncategorized, :expected_income, :plan, :user

    # Returns the ids of the categories the plan moved.
    def apply_plan!
      return [] unless plan
      raise Invalid.new(:invalid_draft) unless plan.valid?

      moved_ids = plan.moved_category_ids
      removed = plan.removed_category_ids
      group_ids = plan.apply!
      @amounts = amounts.except(*removed).transform_keys { |key| group_ids.fetch(key, key) }
      moved_ids
    rescue BudgetPlan::Stale
      raise Invalid.new(:stale_draft)
    end

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
