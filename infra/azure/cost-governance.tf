resource "azurerm_consumption_budget_subscription" "monthly" {
  name            = "qapaq-secops-${var.environment}-monthly"
  subscription_id = "/subscriptions/${var.subscription_id}"
  amount          = var.cost_budget_amount
  time_grain      = "Monthly"

  time_period {
    start_date = var.cost_budget_start_date
    end_date   = var.cost_budget_end_date
  }

  notification {
    enabled        = true
    threshold      = 50
    operator       = "GreaterThan"
    threshold_type = "Actual"
    contact_emails = var.cost_alert_emails
  }

  notification {
    enabled        = true
    threshold      = 75
    operator       = "GreaterThan"
    threshold_type = "Actual"
    contact_emails = var.cost_alert_emails
  }

  notification {
    enabled        = true
    threshold      = 90
    operator       = "GreaterThan"
    threshold_type = "Actual"
    contact_emails = var.cost_alert_emails
  }

  notification {
    enabled        = true
    threshold      = 100
    operator       = "GreaterThan"
    threshold_type = "Actual"
    contact_emails = var.cost_alert_emails
  }

  notification {
    enabled        = true
    threshold      = 100
    operator       = "GreaterThan"
    threshold_type = "Forecasted"
    contact_emails = var.cost_alert_emails
  }
}
