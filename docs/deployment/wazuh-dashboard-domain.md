# Subdominio del Dashboard de Wazuh

La URL prevista de la demo es `https://wazuh.jappi.net.pe/`.
El hostname se configura con `wazuh_dashboard_hostname` en `demo.tfvars`.

Terraform crea un registro A en la zona raíz administrada apuntando a la Elastic IP
de Wazuh y un CAA de Let's Encrypt limitado a ese hostname. No hay que cambiar los
nameservers del registrador ni delegar una zona nueva para este subdominio.

Un documento y una asociación SSM esperan a que el DNS resuelva a la IP esperada,
solicitan un certificado de dominio por HTTP-01 y añaden un virtual host de Nginx
para el Dashboard en 5601. El script valida Nginx antes de recargar y verifica HTTPS.
La renovación usa el mecanismo Certbot y el hook de recarga ya instalados.
No modifica `user_data`, reinstala Wazuh ni reemplaza la instancia EC2.

El endpoint existente por IP queda disponible durante la transición. El nuevo
virtual host registra ruta y método sin query string. Las credenciales y permisos
del Dashboard siguen siendo los configurados en Wazuh.

Después del merge, revisar el plan remoto: se esperan registros A/CAA, documento
SSM y asociación, sin reemplazo de Wazuh. Ejecutar `Terraform Demo` desde `main`
con `action=apply` y comprobar la salida `wazuh_dashboard_url` y el HTTPS del hostname.
Si SSM falla, revisar su ejecución; un registro DNS por sí solo no acredita el certificado.

Estado: configuración preparada; activación y verificación en AWS pendientes.
