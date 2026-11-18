require "test_helper"

class BudgetPlannersControllerTest < ActionDispatch::IntegrationTest
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

  test "defaults to six months and accepts 3 or 12" do
    get budget_planner_path(@month, months: 12)
    assert_select "[data-budget-planner-history-value]" do |nodes|
      assert_equal 12, JSON.parse(nodes.first["data-budget-planner-history-value"])["periods"].size
    end

    get budget_planner_path(@month, months: 999)
    assert_select "[data-budget-planner-history-value]" do |nodes|
      assert_equal 6, JSON.parse(nodes.first["data-budget-planner-history-value"])["periods"].size
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
end
