class BudgetPlannerRestoresController < ApplicationController
  include BudgetPlannerContext

  before_action :require_preview_features!
  before_action :require_non_guest!
  before_action :set_budget

  def create
    backup = Current.family.budget_plan_backup
    return redirect_to(planner_path, alert: t(".none"), status: :see_other) unless backup
    raise ActiveRecord::RecordNotFound if backup.budget && !backup.budget.editable_by?(Current.user)

    missing = backup.restore!
    notice = missing.any? ? t(".restored_missing", names: missing.to_sentence) : t(".restored")
    redirect_to planner_path, notice: notice, status: :see_other
  end
end
