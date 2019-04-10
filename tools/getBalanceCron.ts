import * as _ from 'lodash';
import LineIntegration from '../src/transport/LineIntegration';
import { getConfigRoot } from '../src/configUtil';

const cron = require('node-cron');
const execSync = require('child_process').execSync;

let configRoot;

try {
  configRoot = getConfigRoot();
} catch (ex) {
  console.log(ex.message);
}

let lineConfig;

// notification integrations
if (configRoot) {
    lineConfig = _.get(configRoot, 'logging.line');
}
console.log(lineConfig);
const line = new LineIntegration(lineConfig);

cron.schedule('* * * * *', () => {
  const result : Buffer =  execSync('npx ts-node ./tools/getBalance.ts');
  console.log(result.toString('utf8'));    
  line.handler(result.toString('utf8'));  
});

