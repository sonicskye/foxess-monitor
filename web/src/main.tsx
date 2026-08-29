import { render } from 'preact';
import { App } from './app.tsx';
import './theme.css';
import './styles.css';

render(<App />, document.getElementById('app')!);
