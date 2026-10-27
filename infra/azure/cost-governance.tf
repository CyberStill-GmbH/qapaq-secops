locals {
  # Umbrales de aviso; el presupuesto alerta pero nunca detiene ni destruye recursos.
  budget_notifications = [
    { threshold = 50, threshold_type = "Actual" },
    { threshold = 75, threshold_type = "Actual" },
    { threshold = 90, threshold_type = "Actual" },
    { threshold = 100, threshold_type = "Actual" },
    { threshold = 100, threshold_type = "Forecasted" },
  ]
}

resource "azurerm_consumption_budget_subscription" "monthly" {
  name            = "${var.project}-${var.environment}-monthly"
  subscription_id = "/subscriptions/${var.subscription_id}"
  amount          = var.cost_budget_amount
  time_grain      = "Monthly"

  time_period {
    start_date = var.cost_budget_start_date
    end_date   = var.cost_budget_end_date
  }

  dynamic "notification" {
    for_each = local.budget_notifications
    content {
      enabled        = true
      threshold      = notification.value.threshold
      operator       = "GreaterThan"
      threshold_type = notification.value.threshold_type
      contact_emails = var.cost_alert_emails
    }
  }
}
