/**
 * Conocimiento SOC de reglas estándar de Wazuh (detections/wazuh-stock/stock-rules.yaml): el
 * Analista IA y Qapaqzito reconocen las reglas con más volumen aunque no sean QAPAQ.
 */
import { describe, expect, it } from 'vitest';

import { SOC_KNOWLEDGE } from '../src/assistant/soc-knowledge.generated.js';
import { ruleForAlert, ruleView } from '../src/assistant/soc-knowledge.js';

describe('reglas estándar de Wazuh en el conocimiento SOC', () => {
  it('MailItemsAccessed (91578) trae caso de uso, falsos positivos, criterios de escalado y runbook', () => {
    const rule = ruleForAlert(SOC_KNOWLEDGE, {
      ruleId: '91578',
      title: 'Office 365: Events related to the MailItemsAccessed mailbox auditing action. (wazuh 91578)',
    });
    expect(rule?.id).toBe('91578');
    const view = ruleView(SOC_KNOWLEDGE, rule!);
    expect(view.mitre.map((technique) => technique.id)).toContain('T1114.002');
    const [useCase] = view.useCases;
    expect(useCase?.priorityHint).toBe('P4');
    expect(useCase?.falsePositives.join(' ')).toMatch(/dueño/u);
    expect(useCase?.escalateWhen.length).toBeGreaterThan(0);
    expect(view.runbooks.map((runbook) => runbook.id)).toContain('reglas-estandar-wazuh');
  });

  it('por id resuelve reglas con variables en la descripción (SCA), que el título no encuentra', () => {
    const title =
      'CIS Benchmark for Amazon Linux 2023 Benchmark v1.0.0.: Ensure accounts in /etc/passwd use shadowed passwords. (wazuh 19007)';
    expect(ruleForAlert(SOC_KNOWLEDGE, { ruleId: '19007', title })?.id).toBe('19007');
    expect(ruleForAlert(SOC_KNOWLEDGE, { ruleId: null, title })).toBeUndefined();
  });

  it('cubre las reglas con más volumen en producción (estándar y de plataforma QAPAQ)', () => {
    for (const id of ['91578', '91707', '521', '550', '2904', '5710', '220', '101822', '101859']) {
      expect(SOC_KNOWLEDGE.rules[id], id).toBeDefined();
    }
  });

  it('el runbook de reglas estándar no se apropia de reglas QAPAQ mencionadas en el texto', () => {
    const runbook = SOC_KNOWLEDGE.runbooks.find((entry) => entry.id === 'reglas-estandar-wazuh');
    expect(runbook?.ruleIds).toContain('91578');
    expect(runbook?.ruleIds).not.toContain('100510');
  });
});
