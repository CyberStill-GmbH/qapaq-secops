/**
 * Gramática `qapaq-events-v1` del explorador de eventos.
 *
 * El parser es la frontera entre texto del usuario y la consulta al proveedor: todo lo que no
 * sea un predicado del catálogo se rechaza con posición, sin ignorar fragmentos y sin repetir
 * la consulta en el error.
 */

import { describe, expect, it } from 'vitest';

import {
  EVENTS_QUERY_LIMITS,
  formatEventsQuery,
  parseEventsQuery,
} from '../src/events-query/index.js';

const ok = (input: string) => {
  const result = parseEventsQuery(input);
  if (!result.ok) throw new Error(`se esperaba válida: ${result.error.code}`);
  return result;
};
const error = (input: string) => {
  const result = parseEventsQuery(input);
  if (result.ok) throw new Error('se esperaba un error');
  return result.error;
};

describe('consultas válidas', () => {
  it('un predicado por campo unido con AND, normalizado a forma canónica', () => {
    const result = ok(
      '  Category:Authentication   and severity:HIGH,critical AND outcome:failure ',
    );
    expect(result.filters).toEqual({
      severity: ['high', 'critical'],
      category: ['authentication'],
      outcome: 'failure',
    });
    expect(result.canonical).toBe(
      'severity:high,critical AND category:authentication AND outcome:failure',
    );
  });

  it('valores en el orden del catálogo, sin importar cómo se escriban', () => {
    expect(ok('severity:critical,low,high').canonical).toBe('severity:low,high,critical');
  });

  it('vacía o solo espacios no filtra nada', () => {
    expect(ok('')).toMatchObject({ filters: {}, canonical: '' });
    expect(ok(' \t\n ')).toMatchObject({ filters: {}, canonical: '' });
  });

  it('el formato de filtros visuales y el parser coinciden (sincronización de modos)', () => {
    const filters = { category: ['iam', 'authentication'], severity: ['high'] };
    const canonical = formatEventsQuery(filters);
    expect(canonical).toBe('severity:high AND category:authentication,iam');
    expect(ok(canonical).canonical).toBe(canonical);
  });
});

describe('rechazos con posición', () => {
  const cases: [string, string, string, number][] = [
    ['campo desconocido', 'host:server-1', 'UNKNOWN_FIELD', 0],
    ['campo anidado del proveedor', 'rule.level:12', 'UNKNOWN_FIELD', 0],
    ['valor fuera del catálogo', 'severity:urgente', 'UNKNOWN_VALUE', 9],
    ['severidad unknown no es filtrable', 'severity:unknown', 'UNKNOWN_VALUE', 9],
    ['categoría unclassified no es filtrable', 'category:unclassified', 'UNKNOWN_VALUE', 9],
    ['resultado unknown no es filtrable', 'outcome:unknown', 'UNKNOWN_VALUE', 8],
    ['campo repetido', 'severity:high AND severity:low', 'DUPLICATE_FIELD', 18],
    ['valor repetido', 'severity:high,high', 'DUPLICATE_VALUE', 14],
    ['outcome con varios valores', 'outcome:success,failure', 'SINGLE_VALUE_FIELD', 15],
    ['OR no existe', 'severity:high OR category:iam', 'UNSUPPORTED_OPERATOR', 14],
    ['NOT no existe', 'NOT severity:high', 'UNSUPPORTED_OPERATOR', 0],
    ['predicados sin AND', 'severity:high category:iam', 'UNEXPECTED_TOKEN', 14],
    ['AND al final', 'severity:high AND', 'INCOMPLETE', 17],
    ['falta el valor', 'severity:', 'INCOMPLETE', 9],
    ['falta los dos puntos', 'severity high', 'UNEXPECTED_TOKEN', 9],
    ['coma colgante', 'severity:high,', 'INCOMPLETE', 14],
    ['comillas', 'severity:"high"', 'INVALID_CHARACTER', 9],
    ['paréntesis', '(severity:high)', 'INVALID_CHARACTER', 0],
    ['comodín', 'category:auth*', 'INVALID_CHARACTER', 13],
    ['igualdad estilo DSL', 'source=*', 'INVALID_CHARACTER', 6],
    ['punto y coma', 'severity:high; DROP TABLE x', 'INVALID_CHARACTER', 13],
    ['pipe estilo PPL', 'severity:high | stats count()', 'INVALID_CHARACTER', 14],
    ['ruta del plugin SQL', '/_plugins/_sql', 'INVALID_CHARACTER', 0],
    ['regex', 'category:/auth.*/', 'INVALID_CHARACTER', 9],
    ['comentario SQL', 'severity:high -- x', 'UNEXPECTED_TOKEN', 14],
    ['SQL con comodín', 'SELECT * FROM wazuh', 'INVALID_CHARACTER', 7],
    ['palabra clave SQL', 'SELECT severity FROM wazuh', 'UNSUPPORTED_OPERATOR', 0],
  ];

  it.each(cases)('%s', (_name, input, code, position) => {
    expect(error(input)).toMatchObject({ code, position });
  });

  it('indica qué se esperaba sin repetir la consulta', () => {
    const found = error('severity:urgente');
    expect(found.expected).toEqual(['informational', 'low', 'medium', 'high', 'critical']);
    expect(JSON.stringify(found)).not.toContain('urgente');
  });

  it('límites: largo, predicados, valores y tokens', () => {
    expect(error('a'.repeat(EVENTS_QUERY_LIMITS.maximumLength + 1)).code).toBe('TOO_LONG');
    expect(error('severity:high AND category:iam AND outcome:success AND severity:low').code).toBe(
      'DUPLICATE_FIELD',
    );
    const manyCategories = 'category:' + Array.from({ length: 17 }, () => 'iam').join(',');
    expect(error(manyCategories).code).toBe('DUPLICATE_VALUE');
    expect(error(',,'.repeat(70)).code).toBe('TOO_MANY_TOKENS');
  });

  it('solo ASCII imprimible: rechaza otros alfabetos y caracteres de control', () => {
    expect(error('severity:altaé')).toMatchObject({ code: 'INVALID_CHARACTER', position: 13 });
    expect(error('severity:high\u0000')).toMatchObject({ code: 'INVALID_CHARACTER', position: 13 });
    expect(error('severity:high\ud800')).toMatchObject({ code: 'INVALID_CHARACTER' });
  });
});
