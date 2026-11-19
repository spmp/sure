class BudgetPlannerRestoresController < ApplicationController
  include BudgetPlannerContext

  before_action :require_preview_features!
  before_action :require_non_guest!
  before_action :set_budget

  def create
    backup = Current.family.budget_plan_backup
    return redirect_to(planner_path, alert: t(".none"), status: :see_other) unless backup
    raise ActiveRecord::RecordNotFound if backup.budget && !backup.budget.editable_by?(Current.user)

    backup.restore!
    redirect_to planner_path, notice: t(".restored"), status: :see_other
  rescue BudgetPlanBackup::CannotRestore => e
    redirect_to planner_path, alert: e.message, status: :see_other
  end
end
