# chatgpt MEMORY

Role: reserved expert. Hard algorithms + code review only. Weekly limit is half, do not spend on small tasks.
Branch: harnet/chatgpt-service. Dir: .harnet/agents/chatgpt/wt.
Status: done: chatgpt-service-1.
Log: Finished wb's adapter WIP without redesign: completed payload JSDoc types and corrected adapter test fixtures/expectations. Files: src/adapters/{claude,codex}.js, test/{adapters-contract,claude,codex}.test.js. Verification: npm test 156/156; npm run check green. Left: nothing; ready for orchestrator review.
Log: Added the in-memory control-service wiring for accept/dispatch, adapter signals, timeout/crash handling, FIFO continuation, atomic result groups, and one formatted parent wake-up. Files: src/service/control.js, test/control.test.js. Verification: npm test 164/164; npm run check green. Risk: state is intentionally lost on service restart until DB persistence is implemented. Left: nothing; ready for orchestrator review.
