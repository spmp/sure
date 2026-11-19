# Shared by the budget planner controllers: the budget in the URL, resolved
# like the budget pages (household or personal, via BudgetOwnership), and the
# planner's draft/backup state.
module BudgetPlannerContext
  extend ActiveSupport::Concern

  included do
    include BudgetOwnership
  end

  private
    def set_budget
      start_date = Budget.param_to_date(params[:budget_month_year], family: Current.family)
      @budget = resolve_budget(start_date)
      raise ActiveRecord::RecordNotFound unless @budget&.viewable_by?(Current.user)
    end

    def planner_path
      budget_planner_path(@budget, **budget_owner_query)
    end

    # Rearranging is a family-wide category change; guests only look.
    def can_edit_categories?
      !Current.user.guest?
    end

    def draft_state(draft = Current.family.budget_plan_draft)
      {
        parents: draft&.parents || {},
        groups: draft&.groups || [],
        stale: draft ? draft.stale? : false,
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
