import InfiniteCanvas from './components/InfiniteCanvas';
import LeftToolbar from './components/LeftToolbar';
import BottomBar from './components/BottomBar';
import LocalDocumentBridge from './components/LocalDocumentBridge';
import SceneMenu from './components/SceneMenu';

export default function App() {
  return (
    <div style={{ display: 'flex', width: '100%', height: '100%', overflow: 'hidden' }}>
      <LocalDocumentBridge />
      <LeftToolbar />
      <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        <InfiniteCanvas />
        <SceneMenu />
        <BottomBar />
      </div>
    </div>
  );
}
