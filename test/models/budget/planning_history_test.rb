require "test_helper"

class Budget::PlanningHistoryTest < ActiveSupport::TestCase
  include EntriesTestHelper

  setup do
    @family = families(:empty)
    @food = @family.categories.create!(name: "Food")
    @groceries = @family.categories.create!(name: "Groceries", parent: @food)
    @salary = @family.categories.create!(name: "Salary")
    @account = @family.accounts.create!(name: "Checking", currency: @family.currency, balance: 5000, accountable: Depository.new)

    travel_to Date.new(2026, 4, 15)
    @budget = @family.budgets.create!(start_date: Date.new(2026, 4, 1), end_date: Date.new(2026, 4, 30), currency: @family.currency)
  end

  teardown { travel_back }

  test "periods are the complete budget periods before the budget, oldest first" do
    history = Budget::PlanningHistory.new(@budget, months: 3)

    assert_equal [ Date.new(2026, 1, 1), Date.new(2026, 2, 1), Date.new(2026, 3, 1) ], history.periods.map(&:first)
    assert_equal Date.new(2026, 3, 31), history.periods.last.last
  end

  test "a date range uses the complete budget periods inside it, up to the last finished one" do
    history = Budget::PlanningHistory.new(@budget, start_date: Date.new(2025, 12, 15), end_date: Date.new(2026, 4, 15))

    assert_equal [ Date.new(2026, 1, 1), Date.new(2026, 2, 1), Date.new(2026, 3, 1) ], history.periods.map(&:first)
  end

  test "a range shorter than a period falls back to the last finished period" do
    history = Budget::PlanningHistory.new(@budget, start_date: Date.new(2026, 4, 8), end_date: Date.new(2026, 4, 15))

    assert_equal [ [ Date.new(2026, 3, 1), Date.new(2026, 3, 31) ] ], history.periods
  end

  test "flags categories that have transactions at any date" do
    txn(@groceries, 5, Date.new(2020, 1, 1))

    categories = Budget::PlanningHistory.new(@budget, months: 1).as_json[:categories].index_by { |c| c[:id] }

    assert categories[@groceries.id][:has_transactions]
    refute categories[@food.id][:has_transactions]
  end

  test "spending is netted of refunds per category and period" do
    txn(@groceries, 100, Date.new(2026, 2, 10))
    txn(@groceries, -30, Date.new(2026, 2, 12))
    txn(@groceries, 50, Date.new(2026, 3, 5))
    txn(@groceries, 999, Date.new(2026, 4, 2)) # the budget's own period is left out

    data = Budget::PlanningHistory.new(@budget, months: 3).as_json

    assert_equal [ 0, 70, 50 ], data[:spending][@groceries.id]
  end

  test "transactions on a parent itself stay under the parent's id" do
    txn(@food, 40, Date.new(2026, 3, 5))
    txn(@groceries, 60, Date.new(2026, 3, 6))

    data = Budget::PlanningHistory.new(@budget, months: 1).as_json

    assert_equal [ 40 ], data[:spending][@food.id]
    assert_equal [ 60 ], data[:spending][@groceries.id]
  end

  test "income categories and uncategorized are reported separately" do
    txn(@salary, -2000, Date.new(2026, 3, 1))
    txn(nil, 25, Date.new(2026, 3, 2))

    data = Budget::PlanningHistory.new(@budget, months: 1).as_json

    assert_equal [ 2000 ], data[:income][@salary.id]
    assert_nil data[:spending][@salary.id]
    assert_equal [ 25 ], data[:spending][Budget::PlanningHistory::UNCATEGORIZED_KEY]
  end

  test "transfers are not spending" do
    txn(@groceries, 500, Date.new(2026, 3, 5), kind: "funds_movement")

    assert_empty Budget::PlanningHistory.new(@budget, months: 1).as_json[:spending]
  end

  test "a personal budget only counts its owner's accounts" do
    owner = users(:empty)
    other = @family.users.create!(email: "other@example.com", password: "Password1!", first_name: "O", last_name: "T")
    mine = @family.accounts.create!(name: "Mine", currency: @family.currency, balance: 0, accountable: Depository.new, owner: owner)
    theirs = @family.accounts.create!(name: "Theirs", currency: @family.currency, balance: 0, accountable: Depository.new, owner: other)
    txn(@groceries, 10, Date.new(2026, 3, 5), account: mine)
    txn(@groceries, 90, Date.new(2026, 3, 5), account: theirs)

    personal = @family.budgets.create!(start_date: @budget.start_date, end_date: @budget.end_date, currency: @family.currency, user: owner)

    assert_equal [ 10 ], Budget::PlanningHistory.new(personal, months: 1).as_json[:spending][@groceries.id]
  end

  test "lists the family's categories with their parents" do
    categories = Budget::PlanningHistory.new(@budget, months: 1).as_json[:categories].index_by { |c| c[:id] }

    assert_equal @food.id, categories[@groceries.id][:parent_id]
    assert_nil categories[@food.id][:parent_id]
  end

  private
    def txn(category, amount, date, account: @account, kind: nil)
      attrs = { account: account, category: category, amount: amount, date: date, currency: @family.currency }
      attrs[:kind] = kind if kind
      create_transaction(**attrs)
    end
end
