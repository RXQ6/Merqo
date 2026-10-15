import { useState } from 'react';
import App from '../App';
import { RetailWorkspace } from './RetailWorkspace';
export function RetailRoot() {
  const [agent, setAgent] = useState(false);
  if (!agent) return <RetailWorkspace onOpenAgent={() => setAgent(true)}/>;
  return <><App/><button className="retail-back-to-business" onClick={() => setAgent(false)}>返回经营工作台</button></>;
}
