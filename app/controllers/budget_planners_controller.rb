class BudgetPlannersController < ApplicationController
  include BudgetOwnership

  MONTH_OPTIONS = [ 3, 6, 12 ].freeze

  before_action :require_preview_features!
  before_action :set_budget
  before_action :ensure_budget_editable!, only: :update

  def show
    @months = MONTH_OPTIONS.include?(params[:months].to_i) ? params[:months].to_i : 6
    @history = @budget.planning_history(months: @months)
    @plan_state = Budget::PlanApplication.current_state(@budget, user: Current.user)
    @breadcrumbs = plan_breadcrumb_prefix + [
      [ t("breadcrumbs.budgets"), budget_path(@budget, **budget_owner_query) ],
      [ t(".title"), nil ]
    ]
  end

  def update
    Budget::PlanApplication.new(
      @budget,
      categories: plan_params.fetch(:categories, {}).to_h,
      uncategorized: plan_params.fetch(:uncategorized, 0),
      expected_income: plan_params[:expected_income].presence
    ).apply!

    redirect_to budget_budget_categories_path(@budget, **budget_owner_query), notice: t(".applied", budget: @budget.name), status: :see_other
  rescue Budget::PlanApplication::Invalid => e
    redirect_to budget_planner_path(@budget, **budget_owner_query), alert: e.message, status: :see_other
  end

  private
    def plan_params
      params.require(:plan).permit(:uncategorized, :expected_income, categories: {})
    end

    def set_budget
      start_date = Budget.param_to_date(params[:budget_month_year], family: Current.family)
      @budget = resolve_budget(start_date)
      raise ActiveRecord::RecordNotFound unless @budget&.viewable_by?(Current.user)
    end
end
