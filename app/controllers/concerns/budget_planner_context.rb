# Shared by the budget planner controllers: the budget in the URL, resolved
# like the budget pages (household or personal, via BudgetOwnership), the
# selected plan, and the state the page needs.
module BudgetPlannerContext
  extend ActiveSupport::Concern

  SESSION_KEY = :budget_planner_plan_id

  included do
    include BudgetOwnership
  end

  private
    def set_budget
      start_date = Budget.param_to_date(params[:budget_month_year], family: Current.family)
      @budget = resolve_budget(start_date)
      raise ActiveRecord::RecordNotFound unless @budget&.viewable_by?(Current.user)
    end

    def planner_path(**options)
      budget_planner_path(@budget, **budget_owner_query, **options)
    end

    # Plans change family-wide categories; guests only look.
    def can_edit_categories?
      !Current.user.guest?
    end

    def remember_plan(plan)
      session[SESSION_KEY] = plan&.id
    end

    # `plan=current` (or no remembered plan) means the live categories.
    def selected_plan
      id = params[:plan].presence || session[SESSION_KEY]
      return nil if id.blank? || id == "current"

      Current.family.budget_plans.find_by(id: id)
    end

    def plan_state(plan)
      return nil unless plan

      plan.slice(:id, :name, :parents, :groups, :overrides, :excluded, :removals)
          .merge(stale: plan.stale?, url: budget_planner_plan_path(@budget, plan, **budget_owner_query))
    end

    def draft_state(plan)
      {
        plan: plan_state(plan),
        plans: Current.family.budget_plans.order(:name).map { |p| { id: p.id, name: p.name } },
        create_url: budget_planner_plans_path(@budget, **budget_owner_query),
        can_edit: can_edit_categories?,
        locked: Current.family.categories_locked?
      }
    end

    def backup_state
      backup = Current.family.budget_plan_backup
      return nil unless backup

      { created_at: backup.created_at.iso8601, budget_name: backup.budget&.name }
    end
end
