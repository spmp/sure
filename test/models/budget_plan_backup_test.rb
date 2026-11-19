require "test_helper"

class BudgetPlanBackupTest < ActiveSupport::TestCase
  setup do
    @family = families(:empty)
    @food = @family.categories.create!(name: "Food", color: "#eb5429")
    @groceries = @family.categories.create!(name: "Groceries", parent: @food)
    @coffee = @family.categories.create!(name: "Coffee", color: "#6471eb")
    @budget = @family.budgets.create!(start_date: Date.new(2026, 4, 1), end_date: Date.new(2026, 4, 30), currency: @family.currency,
                                      budgeted_spending: 900, expected_income: 3000)
    @budget.sync_budget_categories
    allocation(@food).update!(budgeted_spending: 500)
    allocation(@groceries).update_budgeted_spending!(200)
  end

  test "restores categories and the budget's amounts as captured" do
    food_before = allocation(@food).budgeted_spending
    backup = BudgetPlanBackup.capture!(@budget, user: users(:empty))

    @groceries.update!(parent: nil)
    @coffee.update!(parent: @food, lucide_icon: "coffee")
    allocation(@food).update!(budgeted_spending: 50)
    @budget.update!(budgeted_spending: 1, expected_income: 2)

    backup.reload.restore!

    assert_equal @food.id, @groceries.reload.parent_id
    assert_nil @coffee.reload.parent_id
    assert_equal "#6471eb", @coffee.color
    assert_equal food_before, allocation(@food).budgeted_spending
    assert_equal 200, allocation(@groceries).budgeted_spending
    assert_equal 900, @budget.reload.budgeted_spending
    assert_equal 3000, @budget.expected_income
  end

  test "keeps one backup per family" do
    BudgetPlanBackup.capture!(@budget, user: nil)
    BudgetPlanBackup.capture!(@budget, user: nil)

    assert_equal 1, BudgetPlanBackup.where(family: @family).count
  end

  test "refuses to restore once a captured category is gone, naming it" do
    backup = BudgetPlanBackup.capture!(@budget, user: nil)
    @coffee.destroy!

    error = assert_raises(BudgetPlanBackup::CannotRestore) { backup.reload.restore! }
    assert_includes error.message, "Coffee"
    assert_equal @food.id, @groceries.reload.parent_id
  end

  test "categories created after the backup are left alone" do
    backup = BudgetPlanBackup.capture!(@budget, user: nil)
    lifestyle = @family.categories.create!(name: "Lifestyle")
    @coffee.update!(parent: lifestyle)

    backup.reload.restore!

    assert_nil @coffee.reload.parent_id
    assert lifestyle.reload.persisted?
  end

  private
    def allocation(category)
      @budget.budget_categories.reload.find_by!(category: category)
    end
end
