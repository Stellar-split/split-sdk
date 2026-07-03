- [ ] Replace all remaining `as any` casts with proper types/type guards across `src/`
- [ ] Confirm `./node_modules/.bin/tsc --noEmit` passes with strict + noUncheckedIndexedAccess
- [x] Add changelog entry for strict-mode upgrade for SDK consumers

- [ ] Add CI type-check step to ALL build workflows (not just publish)
- [ ] Ensure no function parameters/return types are implicitly `any` (verify with `tsc --noEmit`)

