import { InMemoryLedgerStore } from '@commonforge-org/ledger';
import { describeLedgerConformance } from '../src/index.js';

describeLedgerConformance(() => new InMemoryLedgerStore(), { name: 'ledger conformance: InMemoryLedgerStore', allowPortOnlyRecords: true });
