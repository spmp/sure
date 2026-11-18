class BudgetPlannersController < ApplicationController
  include BudgetOwnership

  MONTH_OPTIONS = [ 3, 6, 12 ].freeze

  before_action :require_preview_features!
  before_action :set_budget

  def show
    @months = MONTH_OPTIONS.include?(params[:months].to_i) ? params[:months].to_i : 6
    @history = @budget.planning_history(months: @months)
    @breadcrumbs = plan_breadcrumb_prefix + [
      [ t("breadcrumbs.budgets"), budget_path(@budget, **budget_owner_query) ],
      [ t(".title"), nil ]
    ]
  end

  private
    def set_budget
      start_date = Budget.param_to_date(params[:budget_month_year], family: Current.family)
      @budget = resolve_budget(start_date)
      raise ActiveRecord::RecordNotFound unless @budget&.viewable_by?(Current.user)
    end
end
