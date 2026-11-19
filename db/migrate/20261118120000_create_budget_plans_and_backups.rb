class CreateBudgetPlansAndBackups < ActiveRecord::Migration[8.1]
  def change
    create_table :budget_plans, id: :uuid do |t|
      t.references :family, null: false, foreign_key: true, type: :uuid
      t.string :name, null: false
      t.jsonb :parents, null: false, default: {}
      t.jsonb :groups, null: false, default: []
      t.jsonb :overrides, null: false, default: {}
      t.jsonb :excluded, null: false, default: []
      t.jsonb :removals, null: false, default: {}
      t.string :categories_fingerprint, null: false
      t.references :updated_by, foreign_key: { to_table: :users, on_delete: :nullify }, type: :uuid
      t.timestamps
    end
    add_index :budget_plans, [ :family_id, :name ], unique: true

    create_table :budget_plan_backups, id: :uuid do |t|
      t.references :family, null: false, foreign_key: true, type: :uuid, index: { unique: true }
      t.references :budget, foreign_key: { on_delete: :nullify }, type: :uuid
      t.references :created_by, foreign_key: { to_table: :users, on_delete: :nullify }, type: :uuid
      t.jsonb :categories, null: false, default: []
      t.jsonb :budget_categories, null: false, default: []
      t.decimal :budgeted_spending, precision: 19, scale: 4
      t.decimal :expected_income, precision: 19, scale: 4
      t.timestamps
    end
  end
end
