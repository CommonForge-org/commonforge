import { describeProviderFaultConformance } from '../src/provider.js';
import { makeFakeProvider } from './fake-provider.js';

describeProviderFaultConformance({ name: 'fake provider over local bare repos', makeProvider: makeFakeProvider });
