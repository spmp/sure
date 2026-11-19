class BudgetPlannersController < ApplicationController
  include BudgetPlannerContext

  MONTH_OPTIONS = [ 3, 6, 12 ].freeze

  before_action :require_preview_features!
  before_action :set_budget
  before_action :ensure_budget_editable!, only: :update

  def show
    @months = MONTH_OPTIONS.include?(params[:months].to_i) ? params[:months].to_i : 6
    @history = @budget.planning_history(months: @months)
    @plan_state = Budget::PlanApplication.current_state(@budget, user: Current.user)
    @draft_state = draft_state
    @backup_state = backup_state
    @breadcrumbs = plan_breadcrumb_prefix + [
      [ t("breadcrumbs.budgets"), budget_path(@budget, **budget_owner_query) ],
      [ t(".title"), nil ]
    ]
  end

  def update
    draft = grouping_draft
    if draft&.groups.present? && Current.family.categories_locked?
      return redirect_to planner_path, alert: t("categories.index.locked_message"), status: :see_other
    end

    Budget::PlanApplication.new(
      @budget,
      categories: (plan_params[:categories] || {}).to_h,
      uncategorized: plan_params.fetch(:uncategorized, 0),
      expected_income: plan_params[:expected_income].presence,
      draft: draft,
      user: Current.user
    ).apply!

    redirect_to budget_budget_categories_path(@budget, **budget_owner_query), notice: t(".applied", budget: @budget.name), status: :see_other
  rescue Budget::PlanApplication::Invalid => e
    redirect_to planner_path, alert: e.message, status: :see_other
  end

  private
    def plan_params
      params.require(:plan).permit(:uncategorized, :expected_income, :apply_grouping, categories: {})
    end

    def grouping_draft
      return nil unless plan_params[:apply_grouping] == "1" && can_edit_categories?

      Current.family.budget_plan_draft
    end
end
