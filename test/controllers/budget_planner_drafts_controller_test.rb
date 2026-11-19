require "test_helper"

class BudgetPlannerDraftsControllerTest < ActionDispatch::IntegrationTest
  setup do
    @user = users(:family_admin)
    @user.update!(preferences: @user.preferences.merge("preview_features_enabled" => true))
    @family = @user.family
    @family.update!(categories_locked: false)
    sign_in @user
    @month = Budget.date_to_param(Date.current)
    @parent = @family.categories.create!(name: "Planner parent")
    @loose = @family.categories.create!(name: "Planner loose")
  end

  test "saves the family's draft" do
    patch budget_planner_draft_path(@month), params: draft_params(parents: { @loose.id => @parent.id }), as: :json

    assert_response :success
    assert_equal @parent.id, @family.reload.budget_plan_draft.parents[@loose.id]
    assert_equal false, response.parsed_body["stale"]
  end

  test "rejects an invalid draft" do
    patch budget_planner_draft_path(@month), params: draft_params(parents: { @loose.id => "nope" }), as: :json

    assert_response :unprocessable_entity
    assert_nil @family.reload.budget_plan_draft
  end

  test "starting again deletes the draft" do
    patch budget_planner_draft_path(@month), params: draft_params(parents: { @loose.id => @parent.id }), as: :json
    delete budget_planner_draft_path(@month)

    assert_redirected_to budget_planner_path(@month)
    assert_nil @family.reload.budget_plan_draft
  end

  test "applying with the grouping moves categories and creates groups" do
    patch budget_planner_draft_path(@month),
          params: draft_params(parents: { @loose.id => "new-0000000a" }, groups: [ { key: "new-0000000a", name: "Planner group", color: "#805dee" } ]),
          as: :json

    patch budget_planner_path(@month), params: { plan: { apply_grouping: "1", categories: { "new-0000000a" => 25 } } }

    group = @family.categories.find_by!(name: "Planner group")
    assert_equal group.id, @loose.reload.parent_id
    assert_nil @family.reload.budget_plan_draft
  end

  test "new groups can't be applied while categories are locked" do
    patch budget_planner_draft_path(@month),
          params: draft_params(parents: {}, groups: [ { key: "new-0000000a", name: "Planner group", color: "#805dee" } ]),
          as: :json
    @family.update!(categories_locked: true)

    patch budget_planner_path(@month), params: { plan: { apply_grouping: "1", categories: {} } }

    assert_redirected_to budget_planner_path(@month)
    assert_nil @family.categories.find_by(name: "Planner group")
  end

  test "restore puts back the last apply" do
    patch budget_planner_draft_path(@month), params: draft_params(parents: { @loose.id => @parent.id }), as: :json
    patch budget_planner_path(@month), params: { plan: { apply_grouping: "1", categories: {} } }
    assert_equal @parent.id, @loose.reload.parent_id

    post budget_planner_restore_path(@month)

    assert_redirected_to budget_planner_path(@month)
    assert_nil @loose.reload.parent_id
  end

  test "restore without a backup says so" do
    post budget_planner_restore_path(@month)

    assert_redirected_to budget_planner_path(@month)
    assert_equal I18n.t("budget_planner_restores.create.none"), flash[:alert]
  end

  test "the planner page carries the draft and backup" do
    patch budget_planner_draft_path(@month), params: draft_params(parents: { @loose.id => @parent.id }), as: :json
    get budget_planner_path(@month)

    state = JSON.parse(css_select("[data-budget-planner-draft-value]").first["data-budget-planner-draft-value"])
    assert_equal @parent.id, state["parents"][@loose.id]
    assert_equal true, state["can_edit"]
  end

  private
    def draft_params(parents:, groups: [])
      { draft: { parents: parents, groups: groups } }
    end
end

class BudgetPlannerDraftsGuestTest < ActionDispatch::IntegrationTest
  test "guests can't save a draft" do
    guest = users(:intro_user)
    guest.update!(preferences: guest.preferences.merge("preview_features_enabled" => true))
    sign_in guest
    category = guest.family.categories.create!(name: "Guest cat")

    patch budget_planner_draft_path(Budget.date_to_param(Date.current)), params: { draft: { parents: { category.id => nil } } }, as: :json

    assert_response :forbidden
    assert_nil guest.family.reload.budget_plan_draft
  end
end
