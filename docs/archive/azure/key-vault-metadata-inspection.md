# Inspección de metadatos de Key Vault

El workflow manual `Inspect Azure Key Vault metadata` consulta por GitHub OIDC solo el
inventario de metadatos del vault demo (`nombre`, `enabled` y vencimiento). No llama al
endpoint de datos de Key Vault, no solicita valores, no cambia RBAC/red y no produce
artefactos. Los metadatos se publican en el resumen de la ejecución de GitHub Actions.

La consulta usa el plano de administración de Azure Resource Manager. Azure documenta que
ese plano es independiente del plano de datos; el tipo ARM `Microsoft.KeyVault/vaults/secrets`
indica que el campo `value` nunca se devuelve en respuestas de administración. El acceso a
la red privada del vault sigue siendo necesario para que las cargas de trabajo lean secretos.

## Ejecución

1. Ejecutar el workflow desde `main`, en el environment `azure-demo`.
2. Revisar solo el resumen de metadatos; no habilitar el acceso público al vault.
3. Configurar el perfil SIEM con nombres confirmados y referencias de secretos existentes.
4. El host SIEM conserva su Managed Identity y `Key Vault Secrets User` acotado a los nombres
   que consume; el workflow de inspección no recibe ese rol.

Si ARM deniega la consulta, registrar el código HTTP/error y resolver el permiso `read` del
recurso en su alcance actual. No elevar a `Owner`, no añadir una asignación de lectura de
valores y no cambiar las reglas de red como workaround.
