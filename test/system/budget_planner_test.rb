require "application_system_test_case"

class BudgetPlannerTest < ApplicationSystemTestCase
  include EntriesTestHelper

  setup do
    @user = users(:family_admin)
    @user.update!(preferences: @user.preferences.merge("preview_features_enabled" => true))
    family = @user.family
    account = family.accounts.create!(name: "Planner checking", currency: family.currency, balance: 0, accountable: Depository.new, owner: @user)

    housing = family.categories.create!(name: "Home costs", color: "#6471eb")
    food = family.categories.create!(name: "Food shopping", color: "#eb5429")
    groceries = family.categories.create!(name: "Supermarket", parent: food)
    eating_out = family.categories.create!(name: "Eating out", parent: food)
    salary = family.categories.create!(name: "Pay", color: "#10a861")

    6.times do |i|
      month = Date.current.beginning_of_month - (i + 1).months
      create_transaction(account: account, category: housing, amount: 1500, date: month + 1.day, currency: family.currency)
      create_transaction(account: account, category: groceries, amount: 400 + i * 20, date: month + 5.days, currency: family.currency)
      create_transaction(account: account, category: eating_out, amount: 120 + (i.even? ? 80 : 0), date: month + 9.days, currency: family.currency)
      create_transaction(account: account, category: food, amount: 30, date: month + 12.days, currency: family.currency)
      create_transaction(account: account, category: salary, amount: -4200, date: month + 14.days, currency: family.currency)
    end

    sign_in @user
  end

  test "shows spending circles, history and a panel that hides and selects" do
    visit budget_path(Budget.date_to_param(Date.current))
    click_on "Plan from history"

    assert_selector "h1", text: "Plan from history"
    within "[data-budget-planner-target='panel']" do
      assert_text "Home costs"
      assert_text "Food shopping (direct)"
      assert_no_text "Home costs (direct)"
      assert_text "Pay"
    end
    assert_selector "[data-budget-planner-target='circles'] circle", minimum: 4
    assert_selector "[data-budget-planner-target='history'] rect", count: 6
    save_screenshot(Rails.root.join("tmp/screenshots/budget_planner_desktop.png"))

    circles = all("[data-budget-planner-target='circles'] circle").size
    within("[data-budget-planner-target='panel']") { first("button", text: "Hide").click }
    assert_selector "[data-budget-planner-target='circles'] circle", count: circles - 1, wait: 2

    within("[data-budget-planner-target='panel']") { click_on "Food shopping" }
    assert_selector "[data-budget-planner-target='panel'] button[aria-pressed='true']", text: "Food shopping"
    assert_selector "[data-budget-planner-target='historyTitle']", text: "Food shopping"

    page.driver.browser.manage.window.resize_to(390, 1400)
    visit budget_planner_path(Budget.date_to_param(Date.current))
    assert_selector "[data-budget-planner-target='circles'] circle", minimum: 4
    save_screenshot(Rails.root.join("tmp/screenshots/budget_planner_mobile.png"))
  end

  test "fills amounts from history and applies them to the budget" do
    visit budget_planner_path(Budget.date_to_param(Date.current))

    within("[data-budget-planner-target='form']") do
      click_on "Average"
      home = find("input[aria-label='Home costs budget per month']")
      assert_equal "1500", home.value
      home.fill_in(with: "1600")
      fill_in "plan_expected_income", with: "4200"
    end
    save_screenshot(Rails.root.join("tmp/screenshots/budget_planner_seed.png"))

    click_on "Apply to"
    within("#confirm-dialog") { click_on "Apply" }

    assert_text "now uses these amounts"
    budget = Budget.find_by!(family: @user.family, start_date: Budget.period_for(Date.current, family: @user.family).first, user_id: [ nil, @user.id ])
    home = budget.budget_categories.joins(:category).find_by!(categories: { name: "Home costs" })
    assert_equal 1600, home.budgeted_spending
    assert_equal 4200, budget.expected_income
  end

  test "draft a new group, apply it with the amounts, then restore" do
    visit budget_planner_path(Budget.date_to_param(Date.current))
    click_on "Draft grouping"

    fill_in "New group name", with: "Going out"
    click_on "New group"
    within("[data-budget-planner-target='panel']") do
      assert_text "Going out"
      find("select[aria-label='Move Eating out to']").select("Going out")
      assert_text "Moved"
    end
    assert_selector "[data-budget-planner-target='draftStatus']", text: "Draft saved"
    assert_text "Applying also moves 1 category and creates 1 group."
    save_screenshot(Rails.root.join("tmp/screenshots/budget_planner_draft.png"))

    page.driver.browser.manage.window.resize_to(2200, 1400)
    find("[data-budget-planner-target='widthToggle']").click
    assert_selector "[data-budget-planner-target='widthToggle'][aria-pressed='true']"
    save_screenshot(Rails.root.join("tmp/screenshots/budget_planner_wide.png"))

    click_on "Apply to"
    within("#confirm-dialog") { click_on "Apply" }
    assert_text "now uses these amounts"

    family = @user.family
    going_out = family.categories.find_by!(name: "Going out")
    assert_equal going_out.id, family.categories.find_by!(name: "Eating out").parent_id

    visit budget_planner_path(Budget.date_to_param(Date.current))
    click_on "Restore setup from"
    within("#confirm-dialog") { click_on "Restore setup from" }
    assert_text "back as they were"
    assert_equal family.categories.find_by!(name: "Food shopping").id, family.categories.find_by!(name: "Eating out").parent_id
  end
end
