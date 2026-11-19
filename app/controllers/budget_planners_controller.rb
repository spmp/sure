class BudgetPlannersController < ApplicationController
  include BudgetPlannerContext

  DEFAULT_PERIOD = "last_365_days".freeze

  before_action :require_preview_features!
  before_action :set_budget
  before_action :ensure_budget_editable!, only: :update

  def show
    @period = requested_period
    @history = Budget::PlanningHistory.new(@budget, start_date: @period.start_date, end_date: @period.end_date)
    @plan_state = Budget::PlanApplication.current_state(@budget, user: Current.user)
    plan = selected_plan
    remember_plan(plan) if params.key?(:plan)
    @draft_state = draft_state(plan)
    @backup_state = backup_state
    @breadcrumbs = plan_breadcrumb_prefix + [
      [ t("breadcrumbs.budgets"), budget_path(@budget, **budget_owner_query) ],
      [ t(".title"), nil ]
    ]
  end

  def update
    plan = applying_plan
    if plan&.groups.present? && Current.family.categories_locked?
      return redirect_to planner_path, alert: t("categories.index.locked_message"), status: :see_other
    end

    Budget::PlanApplication.new(
      @budget,
      categories: (plan_params[:categories] || {}).to_h,
      uncategorized: plan_params.fetch(:uncategorized, 0),
      expected_income: plan_params[:expected_income].presence,
      plan: plan,
      user: Current.user
    ).apply!

    redirect_to budget_budget_categories_path(@budget, **budget_owner_query), notice: t(".applied", budget: @budget.name), status: :see_other
  rescue Budget::PlanApplication::Invalid => e
    redirect_to planner_path, alert: e.message, status: :see_other
  end

  private
    def plan_params
      params.require(:plan).permit(:uncategorized, :expected_income, :plan_id, categories: {})
    end

    def applying_plan
      return nil unless plan_params[:plan_id].present? && can_edit_categories?

      Current.family.budget_plans.find_by(id: plan_params[:plan_id])
    end

    # Sure's standard periods (the dashboard's picker), or a custom range
    # given as start_date/end_date. Anything else gets the default.
    def requested_period
      if params[:period].blank? && params[:start_date].present?
        custom = custom_range
        return Period.custom(start_date: custom.first, end_date: custom.last) if custom
      end

      Period.from_key(Period.valid_key?(params[:period].to_s) ? params[:period] : DEFAULT_PERIOD)
    end

    def custom_range
      start_date = Date.iso8601(params[:start_date].to_s)
      end_date = Date.iso8601(params[:end_date].to_s)
      [ start_date, end_date ] if start_date <= end_date
    rescue Date::Error
      nil
    end
end
