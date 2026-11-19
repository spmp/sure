require "test_helper"

class BudgetPlanDraftTest < ActiveSupport::TestCase
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

    assert_raises(BudgetPlanDraft::Stale) { d.reload.apply! }
  end

  private
    def draft(parents: {}, groups: [])
      @family.build_budget_plan_draft(
        parents: parents.transform_keys(&:to_s),
        groups: groups,
        categories_fingerprint: BudgetPlanDraft.fingerprint(@family)
      )
    end

    def group(key, name)
      { "key" => key, "name" => name, "color" => "#805dee" }
    end
end
