require "test_helper"

class BudgetPlanTest < ActiveSupport::TestCase
  include EntriesTestHelper

  setup do
    @family = families(:empty)
    @food = @family.categories.create!(name: "Food", color: "#eb5429")
    @groceries = @family.categories.create!(name: "Groceries", parent: @food)
    @coffee = @family.categories.create!(name: "Coffee", color: "#6471eb")
    @home = @family.categories.create!(name: "Home", color: "#10a861")
    @rent = @family.categories.create!(name: "Rent", parent: @home)
  end

  test "a child can move to another parent or to the top level" do
    assert draft(parents: { @groceries.id => @home.id }).valid?
    assert draft(parents: { @groceries.id => nil }).valid?
  end

  test "a top-level category without children can move under another" do
    assert draft(parents: { @coffee.id => @food.id }).valid?
  end

  test "a category with children can't move under another" do
    refute draft(parents: { @home.id => @food.id }).valid?
  end

  test "it can once its children have moved out" do
    assert draft(parents: { @rent.id => nil, @home.id => @food.id }).valid?
  end

  test "nothing can go under a subcategory" do
    refute draft(parents: { @coffee.id => @groceries.id }).valid?
  end

  test "rejects unknown and other families' categories" do
    other = families(:dylan_family).categories.first

    refute draft(parents: { other.id => nil }).valid?
    refute draft(parents: { @coffee.id => other.id }).valid?
    refute draft(parents: { @coffee.id => "new-0000000a" }).valid?
  end

  test "new groups need a unique name" do
    assert draft(groups: [ group("new-0000000a", "Lifestyle") ], parents: { @coffee.id => "new-0000000a" }).valid?
    refute draft(groups: [ group("new-0000000a", "home") ]).valid?
    refute draft(groups: [ group("new-0000000a", "Fun"), group("new-0000000b", "Fun") ]).valid?
    refute draft(groups: [ group("bad key", "Fun") ]).valid?
  end

  test "a group named like a category being removed is allowed" do
    assert draft(groups: [ group("new-0000000a", "Coffee") ], removals: { @coffee.id => nil }).valid?
  end

  test "goes stale when categories change elsewhere" do
    d = draft(parents: { @coffee.id => @food.id })
    d.save!
    refute d.stale?

    @coffee.update!(name: "Coffee & tea")
    assert d.reload.stale?
  end

  test "applying creates groups and moves categories" do
    d = draft(groups: [ group("new-0000000a", "Lifestyle") ],
              parents: { @coffee.id => "new-0000000a", @groceries.id => @home.id })

    ids = d.apply!

    lifestyle = @family.categories.find_by!(name: "Lifestyle")
    assert_equal({ "new-0000000a" => lifestyle.id }, ids)
    assert_equal lifestyle.id, @coffee.reload.parent_id
    assert_equal @home.id, @groceries.reload.parent_id
    assert_equal @home.color, @groceries.color, "children take their new parent's colour"
  end

  test "applying moves a whole family out before nesting the old parent" do
    draft(parents: { @rent.id => nil, @home.id => @food.id }).apply!

    assert_nil @rent.reload.parent_id
    assert_equal @food.id, @home.reload.parent_id
  end

  test "applying a stale draft fails" do
    d = draft(parents: { @coffee.id => @food.id })
    d.save!
    @coffee.update!(name: "Coffee & tea")

    assert_raises(BudgetPlan::Stale) { d.reload.apply! }
  end

  test "a family can keep several named plans" do
    draft(name: "Lean").save!
    draft(name: "Comfortable").save!
    refute draft(name: "lean").valid?, "names are unique per family, ignoring case"
  end

  test "start copies another plan or begins from current categories" do
    original = draft(name: "Lean", parents: { @coffee.id => @food.id })
    original.save!

    copy = BudgetPlan.start(@family, name: "Lean 2", copy_of: original, user: nil)
    fresh = BudgetPlan.start(@family, name: "Fresh", user: nil)

    assert_equal original.parents, copy.parents
    assert_empty fresh.parents
  end

  test "renames, colours and icons apply, and colour only to top-level categories" do
    d = draft(overrides: { @food.id => { "name" => "Eating", "color" => "#805dee", "icon" => "pizza" },
                           @groceries.id => { "color" => "#000000", "icon" => "apple" } })

    d.apply!

    assert_equal [ "Eating", "#805dee", "pizza" ], @food.reload.values_at(:name, :color, :lucide_icon)
    assert_equal [ "#805dee", "apple" ], @groceries.reload.values_at(:color, :lucide_icon), "children keep their parent's colour"
  end

  test "names must stay unique after renames and new groups" do
    refute draft(overrides: { @coffee.id => { "name" => "home" } }).valid?
    assert draft(overrides: { @coffee.id => { "name" => "Tea" } }).valid?
    refute draft(overrides: { @coffee.id => { "name" => "Fun" } }, groups: [ group("new-0000000a", "Fun") ]).valid?
  end

  test "an empty category can be removed" do
    draft(removals: { @coffee.id => nil }).apply!

    refute Category.exists?(@coffee.id)
  end

  test "a category with transactions is removed only by moving them to another category" do
    entry = create_transaction(category: @coffee, account: @family.accounts.create!(name: "C", currency: "USD", balance: 0, accountable: Depository.new))

    refute draft(removals: { @coffee.id => nil }).valid?

    draft(removals: { @coffee.id => @groceries.id }).apply!
    refute Category.exists?(@coffee.id)
    assert_equal @groceries.id, entry.reload.entryable.category_id
  end

  test "a category can't be removed while it still has subcategories" do
    refute draft(removals: { @home.id => nil }).valid?
    assert draft(removals: { @home.id => nil }, parents: { @rent.id => nil }).valid?
  end

  test "transactions can't be moved to a removed category or the category itself" do
    refute draft(removals: { @coffee.id => @coffee.id }).valid?
    refute draft(removals: { @coffee.id => @food.id, @food.id => nil }).valid?
  end

  test "a new category can wait in Uncategorized and is created without a parent" do
    d = draft(groups: [ group("new-0000000a", "Interest") ], parents: { "new-0000000a" => "uncategorized" })
    assert d.valid?

    ids = d.apply!
    assert_nil Category.find(ids["new-0000000a"]).parent_id
  end

  test "a new category can go under a parent category, existing or new" do
    d = draft(groups: [ group("new-0000000a", "Interest"), group("new-0000000b", "Money") ],
              parents: { "new-0000000a" => @home.id, "new-0000000b" => nil })
    ids = d.apply!
    assert_equal @home.id, Category.find(ids["new-0000000a"]).parent_id

    other = draft(name: "Two", groups: [ group("new-0000000c", "Fees"), group("new-0000000d", "Bank") ],
                  parents: { "new-0000000c" => "new-0000000d" })
    ids = other.apply!
    assert_equal ids["new-0000000d"], Category.find(ids["new-0000000c"]).parent_id
  end

  test "only new categories can wait in Uncategorized" do
    refute draft(parents: { @coffee.id => "uncategorized" }).valid?
  end

  test "a new category under a parent can't have subcategories of its own" do
    refute draft(groups: [ group("new-0000000a", "Fees") ],
                 parents: { "new-0000000a" => @home.id, @coffee.id => "new-0000000a" }).valid?
  end

  test "exclusions name categories, groups or uncategorized" do
    assert draft(excluded: [ @coffee.id, "uncategorized" ]).valid?
    refute draft(excluded: [ "nope" ]).valid?
  end

  private
    def draft(name: "Plan", parents: {}, groups: [], overrides: {}, removals: {}, excluded: [])
      @family.budget_plans.build(
        name: name,
        parents: parents.transform_keys(&:to_s),
        groups: groups,
        overrides: overrides.transform_keys(&:to_s),
        removals: removals.transform_keys(&:to_s),
        excluded: excluded,
        categories_fingerprint: BudgetPlan.fingerprint(@family)
      )
    end

    def group(key, name)
      { "key" => key, "name" => name, "color" => "#805dee", "icon" => "folder" }
    end
end
