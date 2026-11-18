# Income and expense totals per category for each of a list of periods,
# scoped like CategoryStats. Periods are passed in rather than truncated to
# calendar months so they follow the family's budget month start.
class IncomeStatement::CategoryPeriodTotals
  include IncomeStatement::ScopedTransactionsQuery

  Row = Data.define(:category_id, :period_index, :classification, :total)

  def initialize(family, periods:, account_ids: nil)
    @family = family
    @periods = periods
    @account_ids = account_ids
  end

  def call
    return [] if @periods.empty? || @account_ids&.empty?

    ActiveRecord::Base.connection.select_all(sanitized_query_sql).map do |row|
      Row.new(
        category_id: row["category_id"],
        period_index: row["period_index"].to_i,
        classification: row["classification"],
        total: row["total"].to_d
      )
    end
  end

  private
    def sanitized_query_sql
      ActiveRecord::Base.sanitize_sql_array([ query_sql, sql_params ])
    end

    def sql_params
      base_sql_params(
        period_starts: @periods.map(&:first),
        period_ends: @periods.map(&:last)
      )
    end

    def query_sql
      <<~SQL
        WITH periods AS (
          SELECT p.idx - 1 AS period_index, p.starts_on, p.ends_on
          FROM unnest(ARRAY[:period_starts]::date[], ARRAY[:period_ends]::date[]) WITH ORDINALITY AS p(starts_on, ends_on, idx)
        )
        SELECT
          t.category_id,
          periods.period_index,
          #{classification_sql("t")} AS classification,
          COALESCE(SUM(#{converted_amount_sql("t")}), 0) AS total
        FROM transactions t
        #{entries_join_sql("t")}
        #{accounts_join_sql}
        JOIN periods ON ae.date BETWEEN periods.starts_on AND periods.ends_on
        WHERE a.family_id = :family_id
          AND t.kind NOT IN (#{budget_excluded_kinds_sql})
          AND ae.excluded = false
          AND a.exclude_from_reports = false
          #{pending_providers_sql}
          #{exclude_tax_advantaged_sql}
          #{scope_to_account_ids_sql}
          #{excluding_scheduled_sql}
        GROUP BY t.category_id, periods.period_index, #{classification_sql("t")}
      SQL
    end
end
