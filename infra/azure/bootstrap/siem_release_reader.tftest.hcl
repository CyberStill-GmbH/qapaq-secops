mock_provider "azurerm" {
  mock_data "azurerm_client_config" {
    defaults = {
      object_id       = "00000000-0000-4000-8000-000000000010"
      subscription_id = "00000000-0000-0000-0000-000000000000"
      tenant_id       = "00000000-0000-0000-0000-000000000001"
    }
  }

  mock_resource "azurerm_resource_group" {
    defaults = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-qapaqsecopsdemoeus-3a2405f3"
    }
  }

  mock_resource "azurerm_storage_account" {
    defaults = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-qapaqsecopsdemoeus-3a2405f3/providers/Microsoft.Storage/storageAccounts/qapaqstate00000001"
    }
  }

  mock_resource "azurerm_user_assigned_identity" {
    defaults = {
      id           = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-qapaqsecopsdemoeus-state-3a2405f3/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-qapaqsecops-github-tf"
      principal_id = "00000000-0000-4000-8000-000000000020"
    }
  }
}

variables {
  subscription_id                       = "00000000-0000-0000-0000-000000000000"
  tenant_id                             = "00000000-0000-0000-0000-000000000001"
  state_storage_account_name            = "qapaqstate00000001"
  project                               = "qapaq-secops"
  environment                           = "demo-eus2"
  enable_siem_release_reader_delegation = false
}

run "reader_delegation_is_disabled_by_default" {
  command = plan

  assert {
    condition     = length(azurerm_role_assignment.siem_release_reader_delegation) == 0
    error_message = "The additional container-scoped RBAC delegation must remain off by default."
  }

  assert {
    condition = (
      toset(local.delegated_role_definition_ids) == toset([
        "7f951dda-4ed3-4680-a7ca-43fe172d538d",
        "8311e382-0749-4cb8-b61a-304f252e45ec",
        "4633458b-17de-408a-b874-0445c86b69e6",
        "ba92f5b4-2d11-453d-a403-e96b0029c9fe",
      ]) &&
      !contains(local.delegated_role_definition_ids, local.siem_release_reader_role_id) &&
      !contains(local.delegated_role_definition_ids, "b24988ac-6180-42a0-ab88-20f7382dd24c") &&
      !contains(local.delegated_role_definition_ids, "8e3af657-a8ff-443c-a75c-2fe8c4bcb635")
    )
    error_message = "The existing resource-group ABAC allowlist must remain unchanged and exclude Blob Reader, Contributor and Owner."
  }
}

run "reader_delegation_is_limited_to_siem_release_container" {
  command = apply

  variables {
    enable_siem_release_reader_delegation = true
  }

  assert {
    condition = (
      length(azurerm_role_assignment.siem_release_reader_delegation) == 1 &&
      azurerm_role_assignment.siem_release_reader_delegation[0].scope ==
      "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-qapaqsecopsdemoeus-3a2405f3/providers/Microsoft.Storage/storageAccounts/qapaqdemoeus2rel${substr(sha256("${var.subscription_id}:${var.project}:${var.environment}"), 0, 8)}/blobServices/default/containers/siem-release"
    )
    error_message = "The delegated RBAC Administrator scope must be the deterministically named siem-release container."
  }

  assert {
    condition = (
      azurerm_role_assignment.siem_release_reader_delegation[0].role_definition_name == "Role Based Access Control Administrator" &&
      azurerm_role_assignment.siem_release_reader_delegation[0].principal_id == azurerm_user_assigned_identity.github_terraform.principal_id &&
      strcontains(azurerm_role_assignment.siem_release_reader_delegation[0].condition, local.siem_release_reader_role_id) &&
      strcontains(azurerm_role_assignment.siem_release_reader_delegation[0].condition, "'ServicePrincipal'") &&
      strcontains(azurerm_role_assignment.siem_release_reader_delegation[0].condition, "ForAnyOfAllValues:GuidNotEquals") &&
      !strcontains(azurerm_role_assignment.siem_release_reader_delegation[0].condition, "b24988ac-6180-42a0-ab88-20f7382dd24c") &&
      !strcontains(azurerm_role_assignment.siem_release_reader_delegation[0].condition, "8e3af657-a8ff-443c-a75c-2fe8c4bcb635") &&
      !strcontains(azurerm_role_assignment.siem_release_reader_delegation[0].condition, "ba92f5b4-2d11-453d-a403-e96b0029c9fe")
    )
    error_message = "The container delegation must allow only Blob Reader for non-Terraform service principals, not Contributor or Owner."
  }
}
