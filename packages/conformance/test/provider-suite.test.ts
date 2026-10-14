import { describeProviderConformance } from '../src/provider.js';
import { makeFakeProvider } from './fake-provider.js';

describeProviderConformance({ name: 'provider conformance: fake provider over local bare repos', makeProvider: makeFakeProvider });
