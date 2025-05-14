import { Ditto, TransportConfig, IdentityOnlinePlayground, StoreObserver, SyncSubscription, init, QueryResult, QueryResultItem, DQLQueryArguments } from '@dittolive/ditto';
import './App.css'
import DittoInfo from './components/DittoInfo'
import { useEffect, useRef, useState } from 'react';
import TaskList from './components/TaskList';

const identity: IdentityOnlinePlayground = {
  type: 'onlinePlayground',
  appID: import.meta.env.DITTO_APP_ID,
  token: import.meta.env.DITTO_PLAYGROUND_TOKEN,
  customAuthURL: import.meta.env.DITTO_AUTH_URL,
  enableDittoCloudSync: false,
};

export type Task = {
  _id: string;
  title: string;
  done: boolean;
  deleted: boolean;
};

const App = () => {
  const [error, setError] = useState<Error | null>(null);
  const ditto = useRef<Ditto | null>(null);
  const tasksSubscription = useRef<SyncSubscription | null>(null);
  const tasksObserver = useRef<StoreObserver | null>(null);

  const [syncActive, setSyncActive] = useState<boolean>(true);
  const [isInitialized, setIsInitialized] = useState<Promise<void> | null>(null);
  const [dittoInstanceReady, setDittoInstanceReady] = useState<boolean>(false);

  const [tasks, setTasks] = useState<Task[]>([]);
  const [searchQuery, setSearchQuery] = useState<string>('');

  useEffect(() => {
    const initializeDittoSDK = async () => {
      try {
        await init();
        console.log("Ditto SDK base initialized.");
      } catch (e) {
        console.error('Failed to initialize Ditto SDK base:', e);
        setError(e as Error);
      }
    };

    if (!isInitialized) {
      const initPromise = initializeDittoSDK();
      setIsInitialized(initPromise);
    }
  }, []); // Runs once on mount to call init()

  // Effect for initializing Ditto instance and basic sync setup
  useEffect(() => {
    if (!isInitialized) {
      console.log("Ditto instance effect: SDK base not initialized yet.");
      return;
    }

    let localDittoInstance: Ditto | null = null;

    const setupDittoInstance = async () => {
      await isInitialized; // Ensure base init is done
      try {
        console.log("Setting up Ditto instance, transport, and starting sync...");
        const newDitto = new Ditto(identity);
        localDittoInstance = newDitto;
        ditto.current = newDitto;

        const config = new TransportConfig();
        if (import.meta.env.DITTO_WEBSOCKET_URL) {
          config.connect.websocketURLs.push(import.meta.env.DITTO_WEBSOCKET_URL);
        }
        newDitto.setTransportConfig(config);
        await newDitto.disableSyncWithV3();
        newDitto.startSync();
        setSyncActive(true);
        console.log("Ditto instance configured and sync started.");

        tasksSubscription.current = newDitto.sync.registerSubscription('SELECT * FROM tasks');
        console.log("Tasks subscription registered.");
        
        setDittoInstanceReady(true);
        console.log("Ditto instance ready, signaling observer effect.");

      } catch (e) {
        console.error("Error during Ditto instance setup:", e);
        setError(e as Error);
      }
    };

    setupDittoInstance();

    return () => {
      console.log("Cleaning up Ditto instance and subscription...");
      tasksSubscription.current?.cancel();
      tasksSubscription.current = null;
      
      if (tasksObserver.current) {
        tasksObserver.current.cancel();
        tasksObserver.current = null;
      }

      localDittoInstance?.stopSync();
      localDittoInstance?.close();
      ditto.current = null;
      setDittoInstanceReady(false);
      console.log("Ditto instance and subscription cleaned up.");
    };
  }, [isInitialized]);

  // Effect for managing the Ditto observer based on searchQuery and dittoInstanceReady
  useEffect(() => {
    if (!dittoInstanceReady || !ditto.current) {
      console.log("Observer effect: Ditto instance not ready or flag not set.");
      return;
    }
    console.log("Observer effect: searchQuery is:", searchQuery, ", Ditto is ready.");

    if (tasksObserver.current) {
      console.log("Observer effect: Cancelling previous observer.");
      tasksObserver.current.cancel();
    }

    let query = 'SELECT * FROM tasks WHERE deleted=false';
    const queryArgs: DQLQueryArguments = {};

    if (searchQuery && searchQuery.trim() !== '') {
      query += ' AND title ILIKE :searchQuery';
      queryArgs['searchQuery'] = `%${searchQuery.trim()}%`;
    }
    query += ' ORDER BY done';

    console.log("Observer effect: Registering new observer with query:", query, "Args:", queryArgs);
    try {
      tasksObserver.current = ditto.current.store.registerObserver<Task>(
        query,
        (r: QueryResult<Task>) => {
          console.log("Observer received data:", r.items.length, "items. Search query was:", searchQuery);
          const newTasks = r.items.map((item: QueryResultItem) => item.value as Task);
          setTasks(newTasks);
        },
        queryArgs
      );
      console.log("Observer effect: New observer registered.");
    } catch (e) {
      console.error("Error registering observer:", e);
      setError(e as Error);
    }

    return () => {
      console.log("Observer effect: Cleaning up current observer (due to deps change or unmount).");
      if (tasksObserver.current) {
        tasksObserver.current.cancel();
        tasksObserver.current = null;
      }
    };
  }, [searchQuery, dittoInstanceReady]);

  const toggleSync = () => {
    if (syncActive) {
      ditto.current?.stopSync();
    } else {
      ditto.current?.startSync();
    }
    setSyncActive(!syncActive);
  };

  // https://docs.ditto.live/sdk/latest/crud/create
  const createTask = async (title: string) => {
    try {
      await ditto.current?.store.execute("INSERT INTO tasks DOCUMENTS (:task)", {
        task: {
          title,
          done: false,
          deleted: false,
        },
      });
    } catch (error) {
      console.error('Failed to create task:', error);
    }
  };

  // https://docs.ditto.live/sdk/latest/crud/update
  const editTask = async (id: string, title: string) => {
    try {
      await ditto.current?.store.execute("UPDATE tasks SET title=:title WHERE _id=:id", {
        id,
        title,
      });
    } catch (error) {
      console.error('Failed to edit task:', error);
    }
  };

  const toggleTask = async (task: Task) => {
    try {
      await ditto.current?.store.execute("UPDATE tasks SET done=:done WHERE _id=:id", {
        id: task._id,
        done: !task.done,
      });
    } catch (error) {
      console.error('Failed to toggle task:', error);
    }
  };

  // https://docs.ditto.live/sdk/latest/crud/delete#soft-delete-pattern
  const deleteTask = async (task: Task) => {
    try {
      await ditto.current?.store.execute("UPDATE tasks SET deleted=true WHERE _id=:id", {
        id: task._id,
      });
    } catch (error) {
      console.error('Failed to delete task:', error);
    }
  };

  const ErrorMessage: React.FC<{ error: Error }> = ({ error }) => {
    const [dismissed, setDismissed] = useState(false);
    if (dismissed) return null;

    return (
      <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 bg-red-100 text-red-700 p-6 rounded shadow-lg">
        <div className="flex justify-between items-center">
          <p><b>Error</b>: {error.message}</p>
          <button
            onClick={() => setDismissed(true)}
            className="ml-4 text-red-700 hover:text-red-900"
          >
            &times;
          </button>
        </div>
      </div>
    );
  };

  return (
    <div className='h-screen w-full bg-gray-100'>
      <div className='h-full w-full flex flex-col container mx-auto items-center'>
        {error && <ErrorMessage error={error} />}
        <DittoInfo appId={identity.appID} token={identity.token} syncEnabled={syncActive} onToggleSync={toggleSync} />
        <div className="w-full max-w-md p-4">
          <input
            type="text"
            placeholder="Search tasks..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full p-2 border border-gray-300 rounded mb-4"
          />
        </div>
        <TaskList tasks={tasks} onCreate={createTask} onEdit={editTask} onToggle={toggleTask} onDelete={deleteTask} />
      </div>
    </div>
  )
}

export default App
