class BudgetPlannerPlansController < ApplicationController
  include BudgetPlannerContext

  before_action :require_preview_features!
  before_action :require_non_guest!
  before_action :set_budget
  before_action :set_plan, only: %i[update destroy]

  def create
    copy_of = Current.family.budget_plans.find_by(id: params[:copy_of_id]) if params[:copy_of_id].present?
    plan = BudgetPlan.start(Current.family, name: params[:name].to_s.strip, copy_of: copy_of, user: Current.user)
    remember_plan(plan)
    render json: plan_state(plan), status: :created
  rescue ActiveRecord::RecordInvalid => e
    render json: { errors: e.record.errors.full_messages }, status: :unprocessable_entity
  end

  def update
    @plan.assign_attributes(plan_params.merge(updated_by: Current.user))

    if @plan.save
      render json: plan_state(@plan)
    else
      render json: { errors: @plan.errors.full_messages }, status: :unprocessable_entity
    end
  end

  def destroy
    @plan.destroy!
    remember_plan(nil)
    redirect_to planner_path(plan: "current"), status: :see_other
  end

  private
    def set_plan
      @plan = Current.family.budget_plans.find(params[:id])
    end

    # Only the keys sent are changed. JSON nulls (top level, keep
    # transactions-free removal) survive because the hashes are read raw.
    def plan_params
      raw = params.require(:plan)
      attributes = {}
      attributes[:name] = raw[:name].to_s.strip if raw.key?(:name)
      attributes[:parents] = raw[:parents].to_unsafe_h.transform_values(&:presence) if raw.key?(:parents)
      attributes[:removals] = raw[:removals].to_unsafe_h.transform_values(&:presence) if raw.key?(:removals)
      attributes[:groups] = Array(raw[:groups]).map { |g| g.permit(:key, :name, :color, :icon).to_h } if raw.key?(:groups)
      attributes[:overrides] = raw[:overrides].to_unsafe_h.transform_values { |o| o.to_h.slice("name", "color", "icon") } if raw.key?(:overrides)
      attributes[:excluded] = Array(raw[:excluded]).map(&:to_s) if raw.key?(:excluded)
      attributes
    end
end
