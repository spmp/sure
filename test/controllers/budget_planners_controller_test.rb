require "test_helper"

class BudgetPlannersControllerTest < ActionDispatch::IntegrationTest
  def planner_state
    JSON.parse(css_select("[data-budget-planner-plan-value]").first["data-budget-planner-plan-value"])
  end

  setup do
    @user = users(:family_admin)
    @user.update!(preferences: @user.preferences.merge("preview_features_enabled" => true))
    sign_in @user
    ensure_tailwind_build
    @month = Budget.date_to_param(Date.current)
  end

  test "requires the preview opt-in" do
    @user.update!(preferences: @user.preferences.merge("preview_features_enabled" => false))

    get budget_planner_path(@month)

    assert_redirected_to root_path
  end

  test "renders the planner with the budget's history" do
    get budget_planner_path(@month)

    assert_response :success
    assert_select "[data-controller='budget-planner']"
  end

  test "defaults to the last 365 days in whole months" do
    get budget_planner_path(@month)

    assert_select "[data-budget-planner-history-value]" do |nodes|
      assert_includes 11..12, JSON.parse(nodes.first["data-budget-planner-history-value"])["periods"].size
    end
  end

  test "only lists the signed-in family's categories" do
    get budget_planner_path(@month)

    ids = JSON.parse(css_select("[data-budget-planner-history-value]").first["data-budget-planner-history-value"])["categories"].map { |c| c["id"] }
    assert_equal @user.family.categories.pluck(:id).sort, ids.sort
  end

  test "budget page links to the planner only with preview on" do
    get budget_path(@month)
    assert_select "a[href=?]", budget_planner_path(@month)

    @user.update!(preferences: @user.preferences.merge("preview_features_enabled" => false))
    get budget_path(@month)
    assert_select "a[href=?]", budget_planner_path(@month), count: 0
  end

  test "applying a plan writes the budget and returns to it" do
    budget = Budget.find_or_bootstrap(@user.family, start_date: Date.current, user: @user)
    parent = budget.budget_categories.reject(&:subcategory?).first

    patch budget_planner_path(@month), params: { plan: { categories: { parent.category_id => 321 }, uncategorized: 9, expected_income: 5000 } }

    assert_redirected_to budget_budget_categories_path(budget)
    assert_equal 321, parent.reload.budgeted_spending
    assert_equal 5000, budget.reload.expected_income
  end

  test "an invalid plan returns to the planner with the reason" do
    patch budget_planner_path(@month), params: { plan: { categories: { "not-a-category" => 1 } } }

    assert_redirected_to budget_planner_path(@month)
    assert_equal I18n.t("budget_planners.plan_application.errors.unknown_category"), flash[:alert]
  end

  test "the page shows editable amounts only to someone who can edit the budget" do
    get budget_planner_path(@month)

    assert_equal true, planner_state["editable"]
  end
end

class BudgetPlannersControllerSharingTest < ActionDispatch::IntegrationTest
  setup do
    @family = families(:empty)
    @family.update!(personal_budgets: true)
    @owner = users(:josh)
    @viewer = users(:ann)
    @viewer.update!(preferences: @viewer.preferences.merge("preview_features_enabled" => true))
    @date = Date.current.beginning_of_month
    @month = Budget.date_to_param(@date)
    @budget = Budget.find_or_bootstrap(@family, start_date: @date, user: @owner)
    BudgetShare.create!(owner: @owner, viewer: @viewer, permission: "read_only")
    sign_in @viewer
  end

  test "a read-only viewer sees the owner's planner but can't apply a plan" do
    get budget_planner_path(@month, owner: @owner.id)
    assert_response :success
    assert_equal false, JSON.parse(css_select("[data-budget-planner-plan-value]").first["data-budget-planner-plan-value"])["editable"]

    patch budget_planner_path(@month, owner: @owner.id), params: { plan: { categories: {}, uncategorized: 0, expected_income: 1 } }
    assert_response :not_found
    assert_nil @budget.reload.expected_income
  end
end
