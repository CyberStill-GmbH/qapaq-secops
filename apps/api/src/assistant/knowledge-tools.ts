/**
 * Herramientas de conocimiento de Qapaqzito: runbooks y playbooks de docs/17 y el mapeo MITRE ATT&CK
 * de las reglas QAPAQ. Leen el conocimiento empaquetado al compilar (`soc-knowledge.generated.ts`),
 * sin E/S ni datos de clientes.
 */

import type { AssistantTool, ToolInput, ToolOutcome } from '@qapaq/assistant';

import {
  findTechniques,
  ruleView,
  rulesForTechnique,
  searchRunbooks,
  techniqueView,
  type SocKnowledge,
} from './soc-knowledge.js';
import { SOC_KNOWLEDGE } from './soc-knowledge.generated.js';

function text(input: ToolInput, key: string, max = 200): string | undefined {
  const value = input[key];
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  return value.trim().slice(0, max);
}

export function buildKnowledgeTools(knowledge: SocKnowledge = SOC_KNOWLEDGE): AssistantTool[] {
  const runbookIds = knowledge.runbooks.map((runbook) => runbook.id);
  const tools: AssistantTool[] = [
    {
      name: 'get_rule_mitre',
      label: 'Consultando el mapeo MITRE de la regla',
      description: `Mapeo MITRE ATT&CK (${knowledge.attackVersion}) de las reglas de detección QAPAQ: dado un id de regla Wazuh QAPAQ (p. ej. 101740) devuelve descripción, nivel, técnicas con nombre y táctica, caso de uso, falsos positivos conocidos y runbook aplicable. Dado un id de técnica (T1110, T1078.004) o un nombre («fuerza bruta»), devuelve las reglas QAPAQ que la cubren. No sirve para alertas: para una alerta usa get_alert_context, que ya incluye su regla.`,
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ruleId: { type: 'string', pattern: '^\\d{5,6}$', description: 'Id de regla Wazuh QAPAQ.' },
          technique: {
            type: 'string',
            maxLength: 80,
            description: 'Id de técnica ATT&CK (T1110, T1078.004) o parte del nombre.',
          },
        },
      },
      async run(input): Promise<ToolOutcome> {
        const ruleId = text(input, 'ruleId', 6);
        const technique = text(input, 'technique', 80);
        if (ruleId) {
          const rule = knowledge.rules[ruleId];
          if (!rule) {
            return {
              ok: true,
              data: {
                found: false,
                note: `La regla ${ruleId} no está en el catálogo de detecciones QAPAQ (puede ser una regla nativa de Wazuh, cuyo mapeo está en rule.mitre del evento).`,
              },
            };
          }
          return { ok: true, data: { found: true, ...ruleView(knowledge, rule) } };
        }
        if (technique) {
          const ids = /^T\d{4}(\.\d{3})?$/iu.test(technique)
            ? [technique.toUpperCase()]
            : findTechniques(knowledge, technique);
          const results = ids.map((id) => ({
            technique: techniqueView(knowledge, id),
            rules: rulesForTechnique(knowledge, id)
              .slice(0, 15)
              .map((rule) => ({
                ruleId: rule.id,
                level: rule.level,
                description: rule.description,
                runbooks: rule.runbooks ?? [],
              })),
          }));
          return {
            ok: true,
            data: {
              found: results.some((result) => result.rules.length > 0),
              results,
              ...(results.length === 0
                ? { note: 'Ninguna técnica del catálogo QAPAQ coincide con la búsqueda.' }
                : {}),
            },
          };
        }
        return { ok: false, error: 'Indica «ruleId» o «technique».' };
      },
    },
    {
      name: 'lookup_runbook',
      label: 'Consultando los runbooks del SOC',
      description: `Runbooks oficiales de triage e investigación de QAPAQ (docs/17): alcance (reglas), triage en 10 minutos, investigación, contención (siempre por Ankay con aprobación del Líder SOC), recuperación, cierre y consultas KQL. Busca por id de runbook (${runbookIds.join(', ')}), por id de regla o por texto libre («malware», «oleada WAF», «CloudTrail»). Con includePlaybooks=true añade los playbooks de Ankay (qué automatiza cada uno, riesgo y aprobación requerida). Úsala antes de recomendar acciones o pasos de investigación.`,
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          runbookId: { type: 'string', enum: runbookIds },
          ruleId: { type: 'string', pattern: '^\\d{5,6}$' },
          query: { type: 'string', maxLength: 200, description: 'Texto libre.' },
          includePlaybooks: { type: 'boolean' },
        },
      },
      async run(input): Promise<ToolOutcome> {
        const runbookId = text(input, 'runbookId', 80);
        const ruleId = text(input, 'ruleId', 6);
        const query = text(input, 'query');
        let matches = runbookId ? knowledge.runbooks.filter((runbook) => runbook.id === runbookId) : [];
        if (matches.length === 0 && ruleId) {
          matches = knowledge.runbooks.filter((runbook) => runbook.ruleIds.includes(ruleId));
        }
        if (matches.length === 0 && query) matches = searchRunbooks(knowledge, query);
        const playbooks = input['includePlaybooks'] === true ? { playbooks: knowledge.playbooks } : {};
        if (matches.length === 0) {
          return {
            ok: true,
            data: {
              found: false,
              note: 'Ningún runbook coincide. Índice de runbooks disponible abajo.',
              index: knowledge.runbookIndex,
              ...playbooks,
            },
          };
        }
        const [best, ...others] = matches;
        return {
          ok: true,
          data: {
            found: true,
            runbook: { id: best!.id, title: best!.title, path: best!.path, markdown: best!.markdown },
            otherMatches: others.slice(0, 3).map((runbook) => ({ id: runbook.id, title: runbook.title })),
            commonRules: knowledge.runbookIndex.split('Reglas comunes a todos:')[1]?.trim() ?? null,
            ...playbooks,
          },
        };
      },
    },
  ];
  return tools;
}
