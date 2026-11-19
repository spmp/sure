# Per-category income and spending for the complete budget periods before a
# budget, for the planner. Values are per leaf (a parent's own transactions
# stay under the parent's id) so the page can regroup them under any
# hierarchy and take averages of the regrouped monthly sums.
#
# Like the budget page, a category's spending is its expenses less refunds
# in the same period; a category that nets to income counts as income.
class Budget::PlanningHistory
  UNCATEGORIZED_KEY = "uncategorized".freeze

  attr_reader :budget

  # Either the `months` complete budget periods before the budget, or the
  # complete periods between `start_date` and `end_date` that have finished
  # (at least the last finished one).
  def initialize(budget, months: 6, start_date: nil, end_date: nil)
    @budget = budget
    @months = months
    @start_date = start_date
    @end_date = end_date
  end

  # [[start_date, end_date], ...], oldest first.
  def periods
    @periods ||= @start_date ? periods_in_range : periods_before_budget
  end

  def months
    periods.size
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

    def periods_before_budget
      date = budget.start_date
      Array.new(@months) do
        date = Budget.period_for(date - 1.day, family: family).first
        [ date, Budget.period_for(date, family: family).last ]
      end.reverse
    end

    def periods_in_range
      last_finished = Budget.period_for(Date.current, family: family).first - 1.day
      finish = [ @end_date, last_finished ].min
      list = []
      period = Budget.period_for(finish, family: family)
      period = Budget.period_for(period.first - 1.day, family: family) if period.last > finish
      while period.first >= @start_date
        list.unshift(period)
        period = Budget.period_for(period.first - 1.day, family: family)
      end
      list.presence || [ Budget.period_for(last_finished, family: family) ]
    end

    def categories
      used = family.transactions.where.not(category_id: nil).distinct.pluck(:category_id).to_set
      family.categories.order(:name).map do |category|
        { id: category.id, name: category.name, parent_id: category.parent_id, color: category.color,
          icon: category.lucide_icon, has_transactions: used.include?(category.id) }
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
