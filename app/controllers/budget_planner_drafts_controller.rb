class BudgetPlannerDraftsController < ApplicationController
  include BudgetPlannerContext

  before_action :require_preview_features!
  before_action :require_non_guest!
  before_action :set_budget

  def update
    draft = Current.family.budget_plan_draft ||
            Current.family.build_budget_plan_draft(categories_fingerprint: BudgetPlanDraft.fingerprint(Current.family))
    draft.assign_attributes(parents: draft_params[:parents].to_h, groups: draft_params[:groups].map(&:to_h), updated_by: Current.user)

    if draft.save
      render json: draft_state(draft)
    else
      render json: { errors: draft.errors.full_messages }, status: :unprocessable_entity
    end
  end

  def destroy
    Current.family.budget_plan_draft&.destroy!
    redirect_to planner_path, status: :see_other
  end

  private
    def draft_params
      permitted = params.require(:draft).permit(parents: {}, groups: %i[key name color])
      { parents: permitted[:parents] || {}, groups: permitted[:groups] || [] }
    end
end
