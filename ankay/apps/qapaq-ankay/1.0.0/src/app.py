"""App Shuffle «QAPAQ Ankay»: triage de solo lectura y retención de efectos.

Las funciones viven en qapaq_ankay_logic.py; aquí solo se conectan con el SDK de
Shuffle (app_sdk MIT, fijado por commit y SHA-256) y con su caché para deduplicar.
"""

import json
import os

from walkoff_app_sdk.app_base import AppBase

import qapaq_ankay_logic as logic

CATALOG_PATH = os.getenv("QAPAQ_ANKAY_CATALOG", "/app/ankay-catalog.json")
DEDUPE_CATEGORY = "qapaq-ankay-dedupe"


def _load_catalog():
    with open(CATALOG_PATH, encoding="utf-8") as stream:
        return json.load(stream)


class QapaqAnkay(AppBase):
    __version__ = "1.0.0"
    app_name = "QAPAQ Ankay"

    def __init__(self, redis, logger, console_logger=None):
        super().__init__(redis, logger, console_logger)
        self.catalog = _load_catalog()

    def _seen(self, key):
        """Marca la clave y devuelve si ya existía. No es atómico: QAPAQ Core sigue siendo
        la fuente de idempotencia (executionKey) y este paso solo evita trabajo repetido."""
        try:
            current = self.get_cache(key, category=DEDUPE_CATEGORY)
            if isinstance(current, dict) and current.get("success") and current.get("value"):
                return True
            self.set_cache(key, "seen", category=DEDUPE_CATEGORY)
        except Exception:
            # Sin caché no se puede afirmar que sea nuevo ni repetido; se procesa y se marca.
            self.logger.info("qapaq-ankay: dedupe cache unavailable")
        return False

    @staticmethod
    def _result(call):
        try:
            return json.dumps(call(), ensure_ascii=False)
        except logic.TriageError as error:
            return json.dumps({"status": "rejected", "reason": str(error), "effects": "none"})

    def triage_wazuh_alert(self, alert, min_level="12", dispatch_hmac_key=""):
        level = int(min_level) if str(min_level).isdigit() else 12
        return self._result(lambda: logic.triage_wazuh_alert(alert, self.catalog, self._seen, max(level, 12)))

    def verify_governed_dispatch(self, envelope, playbook_id, dispatch_hmac_key=""):
        return self._result(
            lambda: logic.verify_dispatch(envelope, dispatch_hmac_key, self.catalog, playbook_id, self._seen)
        )

    def prepare_read_only_triage(self, verified, dispatch_hmac_key=""):
        return self._result(lambda: logic.prepare_read_only_triage(verified, self.catalog))

    def hold_for_outbox(self, verified, dispatch_hmac_key=""):
        return self._result(lambda: logic.hold_for_outbox(verified, self.catalog))


if __name__ == "__main__":
    QapaqAnkay.run()
