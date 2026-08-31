# ADR-0006: Hermes production, AReaL training-only

**Status:** Accepted target

Hermes владеет production agent loop/session transcript/provider routing. CoffeeOrder plugin использует narrow `agent-v1` API. AReaL используется отдельно для будущего sanitized trajectory/RL training и не входит в production path.
