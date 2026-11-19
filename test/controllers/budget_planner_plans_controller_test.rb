require "test_helper"

class BudgetPlannerPlansControllerTest < ActionDispatch::IntegrationTest
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

  test "creates a plan from current categories and selects it" do
    post budget_planner_plans_path(@month), params: { name: "Lean" }, as: :json

    assert_response :created
    plan = @family.budget_plans.find_by!(name: "Lean")
    assert_equal plan.id, response.parsed_body["id"]
    assert_empty plan.parents

    get budget_planner_path(@month)
    assert_equal plan.id, planner_plan["id"], "the new plan is selected next time"
  end

  test "creates a copy of another plan" do
    original = start_plan(parents: { @loose.id => @parent.id })

    post budget_planner_plans_path(@month), params: { name: "Copy", copy_of_id: original.id }, as: :json

    assert_equal original.parents, @family.budget_plans.find_by!(name: "Copy").parents
  end

  test "a duplicate name is refused" do
    start_plan
    post budget_planner_plans_path(@month), params: { name: "plan" }, as: :json

    assert_response :unprocessable_entity
  end

  test "saves a plan's changes" do
    plan = start_plan

    patch budget_planner_plan_path(@month, plan), params: { plan: { parents: { @loose.id => @parent.id }, overrides: { @parent.id => { name: "Renamed" } }, excluded: [ @loose.id ] } }, as: :json

    assert_response :success
    plan.reload
    assert_equal @parent.id, plan.parents[@loose.id]
    assert_equal "Renamed", plan.overrides.dig(@parent.id, "name")
    assert_equal [ @loose.id ], plan.excluded
  end

  test "rejects an invalid change" do
    plan = start_plan
    patch budget_planner_plan_path(@month, plan), params: { plan: { parents: { @loose.id => "nope" } } }, as: :json

    assert_response :unprocessable_entity
    assert_empty plan.reload.parents
  end

  test "deleting a plan returns to current categories" do
    plan = start_plan
    delete budget_planner_plan_path(@month, plan)

    assert_redirected_to budget_planner_path(@month, plan: "current")
    refute BudgetPlan.exists?(plan.id)
  end

  test "selecting current categories shows no plan" do
    start_plan
    get budget_planner_path(@month, plan: "current")

    assert_nil planner_plan
  end

  test "another family's plan can't be reached" do
    other = families(:empty).budget_plans.create!(name: "Theirs", categories_fingerprint: "x")

    patch budget_planner_plan_path(@month, other), params: { plan: { excluded: [] } }, as: :json
    assert_response :not_found

    get budget_planner_path(@month, plan: other.id)
    assert_nil planner_plan
  end

  test "applying the selected plan moves categories and creates groups" do
    plan = start_plan(parents: { @loose.id => "new-0000000a" }, groups: [ { key: "new-0000000a", name: "Planner group", color: "#805dee", icon: "folder" } ])

    patch budget_planner_path(@month), params: { plan: { plan_id: plan.id, categories: { "new-0000000a" => 25 } } }

    group = @family.categories.find_by!(name: "Planner group")
    assert_equal group.id, @loose.reload.parent_id
    refute BudgetPlan.exists?(plan.id)
  end

  test "new groups can't be applied while categories are locked" do
    plan = start_plan(groups: [ { key: "new-0000000a", name: "Planner group", color: "#805dee", icon: "folder" } ])
    @family.update!(categories_locked: true)

    patch budget_planner_path(@month), params: { plan: { plan_id: plan.id, categories: {} } }

    assert_redirected_to budget_planner_path(@month)
    assert_nil @family.categories.find_by(name: "Planner group")
  end

  test "restore puts back the last apply and names what can't come back" do
    plan = start_plan(parents: { @loose.id => @parent.id })
    patch budget_planner_path(@month), params: { plan: { plan_id: plan.id, categories: {} } }
    assert_equal @parent.id, @loose.reload.parent_id

    post budget_planner_restore_path(@month)

    assert_redirected_to budget_planner_path(@month)
    assert_nil @loose.reload.parent_id
    assert_equal I18n.t("budget_planner_restores.create.restored"), flash[:notice]
  end

  test "restore without a backup says so" do
    post budget_planner_restore_path(@month)

    assert_equal I18n.t("budget_planner_restores.create.none"), flash[:alert]
  end

  test "the page takes Sure's periods or a custom range" do
    get budget_planner_path(@month, period: "last_90_days")
    assert_response :success
    assert_operator history_periods.size, :<=, 3

    get budget_planner_path(@month, period: "custom", start_date: "2024-01-01", end_date: "2024-06-30")
    assert_equal 6, history_periods.size

    get budget_planner_path(@month, period: "nonsense")
    assert_response :success
  end

  private
    def start_plan(parents: {}, groups: [])
      @family.budget_plans.create!(name: "Plan", parents: parents.transform_keys(&:to_s), groups: groups.map(&:stringify_keys),
                                   categories_fingerprint: BudgetPlan.fingerprint(@family))
    end

    def planner_plan
      JSON.parse(css_select("[data-budget-planner-draft-value]").first["data-budget-planner-draft-value"])["plan"]
    end

    def history_periods
      JSON.parse(css_select("[data-budget-planner-history-value]").first["data-budget-planner-history-value"])["periods"]
    end
end

class BudgetPlannerPlansGuestTest < ActionDispatch::IntegrationTest
  test "guests can't create or change plans" do
    guest = users(:intro_user)
    guest.update!(preferences: guest.preferences.merge("preview_features_enabled" => true))
    sign_in guest

    post budget_planner_plans_path(Budget.date_to_param(Date.current)), params: { name: "Mine" }, as: :json

    assert_response :forbidden
    assert_empty guest.family.budget_plans
  end
end
