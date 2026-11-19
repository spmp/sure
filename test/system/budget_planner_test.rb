require "application_system_test_case"

class BudgetPlannerTest < ApplicationSystemTestCase
  include EntriesTestHelper

  setup do
    @user = users(:family_admin)
    @user.update!(preferences: @user.preferences.merge("preview_features_enabled" => true))
    @family = @user.family
    @family.update!(categories_locked: false)
    account = @family.accounts.create!(name: "Planner checking", currency: @family.currency, balance: 0, accountable: Depository.new, owner: @user)

    housing = @family.categories.create!(name: "Home costs", color: "#6471eb")
    food = @family.categories.create!(name: "Food shopping", color: "#eb5429")
    groceries = @family.categories.create!(name: "Supermarket", parent: food)
    eating_out = @family.categories.create!(name: "Eating out", parent: food)
    salary = @family.categories.create!(name: "Pay", color: "#10a861")
    @family.categories.create!(name: "Old stuff", color: "#805dee")
    @loan_interest = @family.categories.create!(name: "Loan interest", color: "#db5a54")

    6.times do |i|
      month = Date.current.beginning_of_month - (i + 1).months
      create_transaction(account: account, category: housing, amount: 1500, date: month + 1.day, currency: @family.currency)
      create_transaction(account: account, category: groceries, amount: 400 + i * 20, date: month + 5.days, currency: @family.currency)
      create_transaction(account: account, category: eating_out, amount: 120 + (i.even? ? 80 : 0), date: month + 9.days, currency: @family.currency)
      create_transaction(account: account, category: food, amount: 30, date: month + 12.days, currency: @family.currency)
      create_transaction(account: account, category: salary, amount: -4200, date: month + 14.days, currency: @family.currency)
    end
    @interest_entry = create_transaction(account: account, category: @loan_interest, amount: 35, date: Date.current.beginning_of_month - 1.month, currency: @family.currency)

    sign_in @user
    @month = Budget.date_to_param(Date.current)
  end

  test "shows circles, history and a panel; the row menu hides and rows select" do
    visit budget_path(@month)
    click_on "Plan from history"

    assert_selector "h1", text: "Plan from history"
    within(panel) do
      assert_text "Home costs"
      assert_text "Food shopping (direct)"
      assert_text "Pay"
    end
    assert_selector "[data-budget-planner-target='circles'] circle", minimum: 4
    save_screenshot(Rails.root.join("tmp/screenshots/budget_planner_desktop.png"))

    circles = all("[data-budget-planner-target='circles'] circle").size
    menu_for("Home costs")
    click_on "Hide from charts"
    assert_selector "[data-budget-planner-target='circles'] circle", count: circles - 1

    food = @family.categories.find_by!(name: "Food shopping")
    assert_no_selector "svg text", text: "Supermarket"
    find("g[data-node-id='#{food.id}']").hover
    assert_selector "svg text", text: "Supermarket"

    within(panel) { click_on "Food shopping" }
    assert_selector "[data-budget-planner-target='historyTitle']", text: "Food shopping"

    page.driver.browser.manage.window.resize_to(390, 1400)
    visit budget_planner_path(@month)
    assert_selector "[data-budget-planner-target='circles'] circle", minimum: 4
    save_screenshot(Rails.root.join("tmp/screenshots/budget_planner_mobile.png"))
  end

  test "a subcategory with no spending in the range still has a circle that can be dragged out" do
    food = @family.categories.find_by!(name: "Food shopping")
    dormant = @family.categories.create!(name: "Car payment", parent: food)
    visit six_months

    circle = find("g[data-node-id='#{dormant.id}']")
    svg = find("[data-budget-planner-target='circles'] svg")
    # Drop in the top-left corner, outside every circle.
    page.driver.browser.action
      .click_and_hold(circle.native)
      .move_to(svg.native, -(svg.native.size.width / 2) + 4, -(svg.native.size.height / 2) + 4)
      .release
      .perform

    within(panel) { assert_text "Moved" }
  end

  test "removing a category that is receiving moved transactions asks where they go instead" do
    visit six_months

    menu_for("Loan interest")
    click_on "Remove category…"
    within(remove_dialog) do
      select "New category…", from: "Move its 1 transactions to"
      fill_in "Name for the new category", with: "Interest"
      click_on "Remove"
    end
    assert_selector "[data-budget-planner-target='draftStatus']", text: "Plan saved"

    menu_for("Interest")
    click_on "Remove category…"
    within(remove_dialog) do
      select "Food shopping", from: "Move its 1 transactions to"
      click_on "Remove"
    end

    within(panel) do
      assert_no_text "Interest\n"
      assert_text "→ Food shopping"
    end
    assert_selector "[data-budget-planner-target='draftStatus']", text: "Plan saved"
    plan = @family.budget_plans.sole
    assert_equal({ @loan_interest.id => @family.categories.find_by!(name: "Food shopping").id }, plan.removals)
    assert_empty plan.groups
  end

  test "fill leaves typed amounts alone, the menu resets one, and apply saves them" do
    visit six_months

    within(form) do
      click_on "Average"
      assert_equal "1500", amount_field("Home costs").value
      amount_field("Home costs").fill_in(with: "1600")
      click_on "Median"
      assert_equal "1600", amount_field("Home costs").value, "a typed amount survives Fill"
    end
    menu_for("Food shopping")
    click_on "Average · $640"
    assert_equal "640", amount_field("Food shopping").value
    fill_in "plan_expected_income", with: "4200"
    save_screenshot(Rails.root.join("tmp/screenshots/budget_planner_seed.png"))

    click_on "Apply to"
    within("#confirm-dialog") { click_on "Apply" }

    assert_text "now uses these amounts"
    budget = Budget.find_by!(family: @family, start_date: Budget.period_for(Date.current, family: @family).first, user_id: [ nil, @user.id ])
    assert_equal 1600, budget.budget_categories.joins(:category).find_by!(categories: { name: "Home costs" }).budgeted_spending
    assert_equal 4200, budget.expected_income
  end

  test "changing categories starts a plan; rename, colour, icon, move, exclude, remove, apply, restore" do
    visit six_months

    fill_in "New group name", with: "Going out"
    click_on "New group"
    assert_selector "[data-budget-planner-target='draftStatus']", text: "Plan saved"
    assert_selector "#planner_plan option:checked", text: "My plan"

    eating_out = @family.categories.find_by!(name: "Eating out")
    find("g[data-node-id='#{eating_out.id}']").drag_to(find("g[data-node-id^='new-']"))
    within(panel) { assert_text "Moved" }

    menu_for("Supermarket")
    accept_prompt(with: "Groceries & co") { click_on "Rename…" }
    within(panel) { assert_text "Groceries & co" }

    menu_for("Home costs")
    click_on "Colour & icon…"
    within("[data-budget-planner-target='appearance']") do
      find("button[data-color='#805dee']").click
      find("label[data-filter-name='house']").click
      click_on "Done"
    end

    menu_for("Pay")
    click_on "Exclude from totals"
    assert_selector "[data-budget-planner-target='excludedNote']", text: "Pay"

    menu_for("Old stuff")
    click_on "Remove category…"
    within(panel) { assert_text "Removed" }

    menu_for("Loan interest")
    click_on "Remove category…"
    within("[data-budget-planner-target='removeDialog']") do
      assert_text "Move its 1 transactions to"
      select "New category…", from: "Move its 1 transactions to"
      fill_in "Name for the new category", with: "Interest"
      click_on "Remove"
    end
    within(panel) { assert_text "Interest" }

    assert_selector "[data-budget-planner-target='draftStatus']", text: "Plan saved"
    assert_text "Applying also changes categories"
    save_screenshot(Rails.root.join("tmp/screenshots/budget_planner_plan.png"))

    click_on "Apply to"
    within("#confirm-dialog") { click_on "Apply" }
    assert_text "now uses these amounts"

    going_out = @family.categories.find_by!(name: "Going out")
    assert_equal going_out.id, @family.categories.find_by!(name: "Eating out").parent_id
    assert @family.categories.exists?(name: "Groceries & co")
    home = @family.categories.find_by!(name: "Home costs")
    assert_equal [ "#805dee", "house" ], [ home.color, home.lucide_icon ]
    refute @family.categories.exists?(name: "Old stuff")
    refute @family.categories.exists?(name: "Loan interest")
    assert_equal @family.categories.find_by!(name: "Interest").id, @interest_entry.reload.entryable.category_id
    assert @family.categories.find_by!(name: "Pay"), "excluding never changes categories"

    visit budget_planner_path(@month)
    click_on "Restore setup from"
    within("#confirm-dialog") { click_on "Restore setup from" }
    assert_text "except"
    assert_text "Old stuff"
    assert_equal @family.categories.find_by!(name: "Food shopping").id, @family.categories.find_by!(name: "Eating out").parent_id
    assert @family.categories.exists?(name: "Supermarket")
  end

  test "plans: create with +, copy, switch back to current categories" do
    visit budget_planner_path(@month, plan: "current")

    find("button[aria-label='New plan']").click
    click_on "Cancel"
    assert_no_field "Plan name"

    find("button[aria-label='New plan']").click
    fill_in "Plan name", with: "Lean"
    click_on "Create plan"
    assert_selector "#planner_plan option:checked", text: "Lean"

    find("button[aria-label='New plan']").click
    fill_in "Plan name", with: "Lean copy"
    choose "Copy of Lean"
    click_on "Create plan"
    assert_selector "#planner_plan option:checked", text: "Lean copy"
    assert_equal 2, @family.budget_plans.count

    select "Current categories", from: "Plan"
    assert_selector "#planner_plan option:checked", text: "Current categories"
  end

  test "sorts, changes the range, and hides and shows the panel" do
    visit budget_planner_path(@month, plan: "current")

    select "Name", from: "Sort by"
    names = all("[data-budget-planner-target='panel'] li > div > button").map(&:text)
    assert_equal names.sort_by(&:downcase), names

    find("button[aria-label='Time period: 365D']").click
    click_on "90D"
    assert_text "(2 months)"

    find("button[aria-label='Time period: 90D']").click
    click_on "MTD"
    assert_text "still in progress"

    click_on "Custom range"
    set_date "planner_start_date", Date.current.beginning_of_month - 4.months
    set_date "planner_end_date", Date.current.beginning_of_month - 1.day
    click_on "Show"
    assert_text "(4 months)"

    page.driver.browser.manage.window.resize_to(2200, 1400)
    visit current_url
    assert_no_selector "button[aria-label='Narrow or wide panel']"
    find("button[aria-label='Hide panel']").click
    assert_no_selector "[data-budget-planner-target='panelCard']", visible: true
    save_screenshot(Rails.root.join("tmp/screenshots/budget_planner_collapsed.png"))
    click_on "Show panel"
    assert_selector "[data-budget-planner-target='panelCard']", visible: true
  end

  private
    def six_months
      budget_planner_path(@month, plan: "current",
                          start_date: (Date.current.beginning_of_month - 6.months).iso8601,
                          end_date: (Date.current.beginning_of_month - 1.day).iso8601)
    end

    # Typing into a date input depends on the browser's locale; set it.
    def set_date(id, date)
      page.execute_script("document.getElementById(arguments[0]).value = arguments[1]", id, date.iso8601)
    end

    def panel
      "[data-budget-planner-target='panel']"
    end

    def remove_dialog
      "[data-budget-planner-target='removeDialog']"
    end

    def form
      "[data-budget-planner-target='form']"
    end

    def menu_for(name)
      find("button[aria-label='More for #{name}']").click
      assert_selector "[role=menu]"
    end

    def amount_field(name)
      find("input[aria-label='#{name} budget per month']")
    end
end
