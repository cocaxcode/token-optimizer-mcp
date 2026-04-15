# ADR-001: Hallazgos de auditoría invalidados (2026-04-15)

## Contexto

Una auditoría de código realizada el 2026-04-15 identificó 15 hallazgos en el proyecto.
Tras revisión manual directa de los archivos, 6 de esos hallazgos resultaron ser
**falsos positivos**. Este ADR los documenta para evitar que futuras auditorías
(manuales o automatizadas) vuelvan a alzarlos.

## Hallazgos invalidados

### 1. `resolveXrayUrl` no existe en `config.ts`
**Veredicto: FALSO.**
La función `resolveXrayUrl` sí existe en `src/cli/config.ts:176`.
El test `xray-client.test.ts` la mockea precisamente porque el import es real.
*La auditoría probablemente buscó en el archivo incorrecto o en una versión stale.*

---

### 2. `detect-opus-for-simple-task` truncada / incompleta
**Veredicto: FALSO.**
La rule está completa en `src/coach/rules.ts:141-161`.
Tiene guard por `ctx.active_model` con regex `/opus/i`, mínimo de eventos
mecánicos (`edits + bash < 6`), y retorna un hit bien formado con tests de cobertura.
*La auditoría confundió esta rule con el stub `detect-unused-mcp-servers`
(que sí era `return null`, y fue eliminado en Sprint A).*

---

### 3. Token estimation off ×2 por output bytes vs chars
**Veredicto: FALSO (funcional). Naming mejorado en Sprint B.**
`extractOutputBytes` usaba `response.length` en strings JS, que devuelve
**UTF-16 code units**, no bytes. El ratio `× 0.27` estaba calibrado contra
chars JS, no bytes. No había inflación ×2 — el cálculo era correcto.
Sí era un *misnomer*: función y variable renombradas a `extractOutputChars`
y `outputChars` en Sprint B para mayor claridad.

---

### 4. Coach throttle out-of-phase (off-by-one)
**Veredicto: NON-ISSUE.**
`countToolCallsBySession()` se llama después de insertar el evento,
por lo que `count % throttle === 0` evalúa con el evento ya incluido.
Esto es correcto: el hint del evento N contiene datos de los eventos 1–N,
que es exactamente el contexto relevante para la detección de patrones.
*La propia auditoría admitía la duda; verificación directa confirma que no hay bug.*

---

### 5. Project hash colisión (16 hex chars)
**Veredicto: IGNORAR.**
SHA-256 truncado a 16 hex = 64 bits de entropía.
Con 10 000 proyectos: P(colisión) ≈ 5×10⁻¹⁰.
Para developer tooling monousuario esto es ruido estadístico.
*Aplazar indefinidamente salvo escenario multi-tenant demostrado.*

---

### 6. `purgeStaleRtkMarks()` nunca se invoca
**Veredicto: FALSO.**
`purgeStaleRtkMarks()` se invoca en `src/hooks/pretooluse.ts` justo después de
`insertRtkRewrite`. La auditoría no leyó completamente el archivo.

---

## Lecciones

- Antes de actuar sobre un hallazgo de auditoría, verificar con `grep` + lectura directa.
- La auditoría tuvo ~40% de falsos positivos en Tier 1-2 — tasa alta que indica
  lectura superficial o confusión entre versiones de archivos.
- Los hallazgos **reales** de esa auditoría (corregidos en Sprint A) fueron:
  - `slice(3)` → `slice('rtk '.length)` en `pretooluse.ts`
  - Shadow measurement de Serena nunca invocado (wired en Sprint A)
  - `detect-unused-mcp-servers` stub siempre `return null` (eliminado en Sprint A)
