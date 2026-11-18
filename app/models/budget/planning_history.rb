# Per-category income and spending for the complete budget periods before a
# budget, for the planner. Values are per leaf (a parent's own transactions
# stay under the parent's id) so the page can regroup them under any
# hierarchy and take averages of the regrouped monthly sums.
#
# Like the budget page, a category's spending is its expenses less refunds
# in the same period; a category that nets to income counts as income.
class Budget::PlanningHistory
  UNCATEGORIZED_KEY = "uncategorized".freeze

  attr_reader :budget, :months

  def initialize(budget, months: 6)
    @budget = budget
    @months = months
  end

  # [[start_date, end_date], ...], oldest first.
  def periods
    @periods ||= begin
      date = budget.start_date
      Array.new(months) do
        date = Budget.period_for(date - 1.day, family: family).first
        [ date, Budget.period_for(date, family: family).last ]
      end.reverse
    end
  end

  def as_json(*)
    spending, income = split_net_totals

    {
      currency: family.currency,
      periods: periods.map { |starts_on, ends_on| { start_date: starts_on, end_date: ends_on } },
      categories: categories,
      uncategorized: { name: Category.uncategorized.name, color: Category::UNCATEGORIZED_COLOR },
      spending: spending,
      income: income
    }
  end

  private
    def family
      budget.family
    end

    def categories
      family.categories.order(:name).map do |category|
        { id: category.id, name: category.name, parent_id: category.parent_id, color: category.color, icon: category.lucide_icon }
      end
    end

    def split_net_totals
      net = Hash.new { |hash, key| hash[key] = Array.new(months, 0) }

      rows.each do |row|
        next unless row.classification.in?(%w[expense income])

        # Totals are signed like entries: expenses positive, income negative.
        net[row.category_id || UNCATEGORIZED_KEY][row.period_index] += row.total
      end

      spending = {}
      income = {}
      net.each do |key, values|
        if values.sum.positive?
          spending[key] = values.map { |v| [ v, 0 ].max.to_f }
        elsif values.sum.negative?
          income[key] = values.map { |v| [ -v, 0 ].max.to_f }
        end
      end

      [ spending, income ]
    end

    def rows
      budget.category_period_totals(periods)
    end
end
