require "test_helper"

class Budget::PlanApplicationTest < ActiveSupport::TestCase
  setup do
    @family = families(:empty)
    @food = @family.categories.create!(name: "Food")
    @groceries = @family.categories.create!(name: "Groceries", parent: @food)
    @eating_out = @family.categories.create!(name: "Eating out", parent: @food)
    @home = @family.categories.create!(name: "Home")
    @budget = @family.budgets.create!(start_date: Date.new(2026, 4, 1), end_date: Date.new(2026, 4, 30), currency: @family.currency)
    @budget.sync_budget_categories
  end

  test "sets parent amounts, the budget total and expected income" do
    apply(categories: { @food.id => 600, @home.id => 1500 }, uncategorized: 100, expected_income: 4000)

    assert_equal 600, allocation(@food)
    assert_equal 1500, allocation(@home)
    assert_equal 2200, @budget.reload.budgeted_spending
    assert_equal 4000, @budget.expected_income
  end

  test "leaves subcategories that share the parent's budget at zero" do
    apply(categories: { @food.id => 600 })

    assert_equal 0, allocation(@groceries)
    assert_equal 0, allocation(@eating_out)
  end

  test "a parent can't go below its subcategories' own amounts" do
    budget_category(@groceries).update_budgeted_spending!(400)

    error = assert_raises(Budget::PlanApplication::Invalid) { apply(categories: { @food.id => 300 }) }

    assert_equal [ @food.id ], error.category_ids
    assert_equal 400, allocation(@food), "nothing changes when the plan is invalid"
  end

  test "keeps subcategory amounts and counts categories left out of the plan in the total" do
    budget_category(@groceries).update_budgeted_spending!(400)
    budget_category(@home).update_budgeted_spending!(1000)

    apply(categories: { @food.id => 700 })

    assert_equal 400, allocation(@groceries)
    assert_equal 700, allocation(@food)
    assert_equal 1700, @budget.reload.budgeted_spending
  end

  test "rejects subcategories and other families' categories" do
    other = families(:dylan_family).categories.first

    assert_raises(Budget::PlanApplication::Invalid) { apply(categories: { @groceries.id => 10 }) }
    assert_raises(Budget::PlanApplication::Invalid) { apply(categories: { other.id => 10 }) }
  end

  test "rejects negative amounts" do
    assert_raises(Budget::PlanApplication::Invalid) { apply(categories: { @food.id => -1 }) }
  end

  test "recomputes rollover once" do
    Budget::RolloverCalculator.any_instance.expects(:recompute!).once

    apply(categories: { @food.id => 600 })
  end

  private
    def apply(categories:, uncategorized: 0, expected_income: nil)
      Budget::PlanApplication.new(@budget, categories: categories, uncategorized: uncategorized, expected_income: expected_income).apply!
    end

    def budget_category(category)
      @budget.budget_categories.reload.find_by!(category: category)
    end

    def allocation(category)
      budget_category(category).budgeted_spending
    end
end
