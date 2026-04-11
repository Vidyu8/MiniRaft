# **YAK - Yet Another Kafka**

**A Deep Dive into Distributed Systems Principles**



## **Overview**

YAK is a fault-tolerant message broker built from scratch in Python. It is inspired by the core mechanics of distributed systems like Apache Kafka. This project is not intended for production use but serves as a powerful educational tool to understand the fundamental challenges and solutions in distributed computing, including leader election, synchronous data replication, and automatic client failover.

The system is designed to withstand the catastrophic failure of its leader node with **zero data loss** for any acknowledged message, providing a hands-on demonstration of mission-critical system design.

---

## **Table of Contents**
1.  [**Core Architectural Concepts**](#1-core-architectural-concepts)
    *   The Problem: Why Distributed Systems are Hard
    *   Solution 1: Atomic Leader Election
    *   Solution 2: Synchronous "In-Sync" Replication
    *   Solution 3: The High Water Mark (HWM) for Safe Consumption
    *   Solution 4: Intelligent, Cluster-Aware Clients

2.  [**Deep Dive: The Role of Redis**](#2-deep-dive-the-role-of-redis)
    *   The Leader Lease Key (`yak:leader_lease`)
    *   The High Water Mark Key (`yak:hwm`)
    *   Why Redis?

3.  [**Anatomy of a Message Lifecycle**](#3-anatomy-of-a-message-lifecycle)
    *   The Message Payload
    *   Offsets Explained
    *   The Replication Flow: A Step-by-Step Journey

4.  [**Codebase Deep Dive: Every File and Function Explained**](#4-codebase-deep-dive-every-file-and-function-explained)
    *   Directory Structure
    *   The `broker/` Directory
    *   The `client/` Directory
    *   The `scripts/` Directory

5.  [**Local Setup and Demonstration Guide**](#5-local-setup-and-demonstration-guide)
    *   Prerequisites
    *   Installation Commands
    *   Running the 4-Terminal Demo
    *   Simulating the Leader Crash: The Main Event

6.  [**Distributed Setup with ZeroTier**](#6-distributed-setup-with-zerotier)
    *   What is ZeroTier and Why Use It?
    *   Prerequisites for Distributed Setup
    *   Step 1: Create and Configure a ZeroTier Network
    *   Step 2: Configure the YAK Project for the Network
    *   Step 3: Run the Distributed Demonstration

7.  [**The Failover Sequence: A Microsecond Breakdown**](#7-the-failover-sequence-a-microsecond-breakdown)

---

## **1. Core Architectural Concepts**

### The Problem: Why Distributed Systems are Hard
In a single computer, tasks are simple. But when you have multiple computers (nodes) working together, you face difficult questions:
- **Who is in charge?** If two nodes both accept data, which data is correct? This is the "split-brain" problem, leading to data inconsistency.
- **What if a node dies?** If the leader node fails, how do we ensure no data is lost and another node takes over seamlessly and automatically?
- **How do we guarantee consistency?** How can we be sure that data written to one node is safely copied to others before we tell the user "your data is saved"?

YAK is designed to solve these problems from first principles.

### Solution 1: Atomic Leader Election
To prevent a "split-brain," there can only be one leader. YAK uses an external, neutral arbitrator—**Redis**—to manage this.
- **The Lease:** The leader doesn't own its title forever; it only *leases* it for a short period (10 seconds). Think of it as a token in a "king of the hill" game.
- **Acquiring the Lease:** On startup, all brokers attempt to create a special key in Redis using an **atomic `SETNX` (SET if Not eXists)** command. Because the operation is atomic, only the very first broker to execute the command will succeed. This broker wins the election and becomes the **Leader**.
- **Maintaining Leadership:** The Leader must constantly renew its lease before the 10-second timeout expires. This acts as a "heartbeat," proving to the rest of the system that it is still alive and well.
- **Failover:** If the Leader crashes, it stops renewing its lease. The key in Redis automatically expires. The waiting **Follower** nodes will notice the key is gone and will immediately race to acquire a new lease. One will win, promote itself to Leader, and the system heals.

### Solution 2: Synchronous "In-Sync" Replication
To guarantee zero data loss, YAK uses synchronous replication. A message is not considered "committed" until the Leader gets confirmation that it has been safely copied to the Follower. This keeps the Follower "in-sync" with the Leader. If the Leader fails, the Follower has an identical copy of all acknowledged data and is ready to take over.

### Solution 3: The High Water Mark (HWM) for Safe Consumption
The HWM is the single most important concept for data safety from a consumer's perspective.
- **Definition:** The HWM is an integer (an offset) that represents the offset of the last message that has been successfully copied to *all* in-sync brokers.
- **How it works:** The Leader only updates the HWM *after* it receives an acknowledgment from the Follower.
- **Why it matters:** The API enforces a strict rule: Consumers can only read messages up to the HWM. This prevents a consumer from ever reading a message that only existed on the Leader and was not yet replicated. If the Leader crashed after writing a message but before replicating it, that message would have an offset *higher* than the HWM, and no consumer would have ever been allowed to see it. This guarantees that **any message you read has survived failure**.

### Solution 4: Intelligent, Cluster-Aware Clients
The Producer and Consumer are not naive. They know they are talking to a cluster, not a single server.
- **Leader Discovery:** Clients are configured with a list of all known broker addresses. On startup, or when they lose connection, they query the `/metadata/leader` endpoint on any available broker to find the current leader's address.
- **Resilience & Patience:** If a client sends a request to the leader and it fails, it assumes the leader is dead. It then **patiently** waits for a new leader to be elected (checking periodically) before automatically retrying the original request on the newly discovered leader.

---

## **2. Deep Dive: The Role of Redis**

Redis is the central nervous system of the YAK cluster. It is the definitive source of truth for the cluster's state.

### The Leader Lease Key (`yak:leader_lease`)
This key manages leader election.
- **Command Used:** `SET yak:leader_lease "http://10.1.1.1:5001" NX EX 10`
    - `SET yak:leader_lease ...`: Sets the key with the leader's address as the value.
    - `NX`: **(Not eXists)** This is the magic. It means "only set this key if it does not already exist." This is what makes the election atomic and fair.
    - `EX 10`: **(Expires)** Sets a 10-second timeout on the key. If the leader doesn't renew it, the key is automatically deleted by Redis.

### The High Water Mark Key (`yak:hwm`)
This key ensures consumer data consistency.
- **Command Used:** `SET yak:hwm 123`
- **Lifecycle:**
    1. A Producer sends message #123 to the Leader.
    2. The Leader replicates it to the Follower.
    3. The Follower sends an ACK to the Leader.
    4. The Leader runs `SET yak:hwm 123` in Redis.
    5. A Consumer now asks for messages. The Leader checks the HWM in Redis and sees `123`, so it knows it is safe to send message #123 to the consumer.

### Why Redis?
- **Speed:** Redis is an in-memory database, making lookups for the lease and HWM incredibly fast.
- **Atomicity:** Operations like `SETNX` are guaranteed to be atomic, which is a non-negotiable requirement for a reliable leader election.
- **Simplicity:** Features like built-in key expiration (`EX`) perfectly map to the concept of a lease, simplifying the broker's logic.

---

## **3. Anatomy of a Message Lifecycle**

### The Message Payload
A message in YAK is a simple JSON object sent via a `POST` request.
```json
{ "payload": "This is a test message." }
```

### Offsets Explained
An offset is a unique, sequential ID given to every message. In YAK's simple implementation, the offset is the **line number** in the broker's local log file. The Consumer is responsible for tracking the last offset it successfully processed so it knows where to resume reading from.

### The Replication Flow: A Step-by-Step Journey
Imagine a producer sending "Hello" at offset 42.

| Step | Component | Action | State Change |
| :--- | :--- | :--- | :--- |
| 1 | Producer | Sends `POST /produce` with "Hello" to Leader. | - |
| 2 | Leader | Receives request. | - |
| 3 | Leader | Appends "Hello" to line 42 of `broker_1_log.log`. | Leader log now has message 42. |
| 4 | Leader | Sends `POST /internal/replicate` with "Hello" to Follower. | - |
| 5 | Follower | Receives replication request. | - |
| 6 | Follower | Appends "Hello" to line 42 of `broker_2_log.log`. | Follower log now has message 42. |
| 7 | Follower | Responds `200 OK` (ACK) to Leader. | - |
| 8 | Leader | Receives ACK. | - |
| 9 | Leader | Connects to Redis, runs `SET yak:hwm 42`. | HWM in Redis is now 42. |
| 10 | Leader | Responds `200 OK` with `{"offset": 42}` to Producer. | Message is fully durable. |

---

## **4. Codebase Deep Dive: Every File and Function Explained**

### Directory Structure
```
YAK_PROJECT/
├── broker/                  # Package for all server-side (Broker) logic.
│   ├── __pycache__/         # (Generated) Python's cached bytecode.
│   ├── app.py               # Flask web server defining all API endpoints.
│   ├── config.py            # Centralized configuration (Redis, lease times).
│   ├── log_manager.py       # Handles reading/writing the local message log.
│   ├── main.py              # The executable entry point to start a broker.
│   ├── replication.py       # Logic for Leader to replicate to Follower.
│   └── state_manager.py     # The "brain" managing state and leader election.
│
├── client/                  # Package for all client-side logic.
│   ├── __pycache__/         # (Generated) Python's cached bytecode.
│   ├── client_logic.py      # Shared "intelligent" code for failover.
│   ├── consumer.py          # The consumer application.
│   └── producer.py          # The producer application.
│
├── scripts/                 # Helper scripts for running the brokers.
│   ├── start_broker_1.sh    # Starts the first broker.
│   └── start_broker_2.sh    # Starts the second broker.
│
├── broker_1_log.log         # (Generated) The actual data log for Broker 1.
├── broker_2_log.log         # (Generated) The actual data log for Broker 2.
├── readme.md                # This documentation.
└── requirements.txt         # Project dependencies for pip.
```

### The `broker/` Directory

<details>
<summary><b><code>config.py</code> — Central Configuration Hub</b></summary>

This file holds static configuration values used by the broker. Centralizing them here makes the system easy to reconfigure.
- `REDIS_HOST`, `REDIS_PORT`: Where to find the Redis server.
- `LEADER_LEASE_KEY`, `HWM_KEY`: The names of the keys used in Redis to avoid magic strings.
- `LEASE_TIMEOUT_SECONDS`: The duration (in seconds) of the leader lease.
</details>

<details>
<summary><b><code>log_manager.py</code> — Log File Abstraction</b></summary>

This class abstracts away file I/O for the message log. It treats a simple text file like a message queue.
- **`LogManager. __init__(self, broker_id)`**: Constructor. Creates a unique log file name (e.g., `broker_1_log.log`) and clears it on startup for a clean demo.
- **`LogManager.write_message(self, message_data)`**: Appends a message (as a JSON string) to a new line in the log file and returns its line number, which serves as the message **offset**.
- **`LogManager.read_messages(self, start_offset)`**: Reads all messages from the log file starting from the given offset.
</details>

<details>
<summary><b><code>state_manager.py</code> — The Broker's Brain</b></summary>

This class manages the broker's role (leader/follower) and handles all leader election logic.
- **`StateManager.__init__(self, ...)`**: Initializes the Redis client and sets the broker's default role to "follower".
- **`StateManager.start(self)`**: Kicks off a background `threading.Thread` that runs the `_manage_state_loop`, allowing election logic to run without blocking the main web server.
- **`StateManager._manage_state_loop(self)`**: The core loop. If the broker is a leader, it calls `_renew_lease`. If it's a follower, it calls `_try_to_become_leader`.
- **`StateManager._renew_lease(self)`**: Resets the TTL on the Redis lease key to maintain leadership, effectively acting as a heartbeat.
- **`StateManager._try_to_become_leader(self)`**: Attempts the atomic `SETNX` command in Redis. If successful, it calls `_promote_to_leader`.
- **`StateManager._promote_to_leader(self)`**: Prints the promotion message and changes the internal `self.role` to "leader".
- **`StateManager.get_hwm()`, `.update_hwm()`**: Helper functions to read from and write to the HWM key in Redis.
- **`StateManager.get_leader()`**, **`.is_leader()`**: Simple getters for the broker's current state.
</details>

<details>
<summary><b><code>replication.py</code> — The Replication Workhorse</b></summary>

This file contains the logic for the leader to replicate data to a follower.
- **`unhealthy_followers = set()`**: A crucial module-level variable. It's an in-memory set that tracks followers known to be offline. This prevents the leader from spamming the logs with connection errors for a follower that is already dead.
- **`replicate_to_follower(follower_address, message)`**: Tries to `POST` a message to the follower. If it fails, it adds the follower to the `unhealthy_followers` set and prints a single, detailed error. On subsequent calls for that follower, it fails immediately, keeping the logs clean.
</details>

<details>
<summary><b><code>app.py</code> — The Web API Layer</b></summary>

This is the Flask web server that defines the broker's public API.
- **`initialize_app(...)`**: A factory function to create and configure the Flask app instance.
- **`@app.route('/produce', methods=['POST'])`**: The main endpoint for writing data. It first checks if the broker is the leader. If not, it rejects with `HTTP 421 Misdirected Request`. If it is, it orchestrates the replication flow: write locally -> `replicate_to_follower()` -> update HWM.
- **`@app.route('/internal/replicate', methods=['POST'])`**: An internal-only endpoint for the follower to receive data from the leader.
- **`@app.route('/consume', methods=['GET'])`**: The endpoint for consumers to read data. It reads from its local log but only returns messages up to the HWM fetched from Redis.
- **`@app.route('/metadata/leader', methods=['GET'])`**: A simple endpoint that returns the current leader's address from Redis. This is used by clients for discovery.
</details>

<details>
<summary><b><code>main.py</code> — The Entry Point</b></summary>

A simple script to launch a broker instance. Its sole job is to parse command-line arguments (broker ID, own address, peer address) and pass them to the `initialize_app` and `app.run` functions.
</details>

### The `client/` Directory

<details>
<summary><b><code>client_logic.py</code> — Shared Client Intelligence</b></summary>

This file contains the shared "intelligence" for both the producer and consumer, handling all failover logic.
- **`ClientLogic.__init__(self, broker_list)`**: Constructor. Stores the list of all known broker addresses and immediately calls `find_leader()` to establish an initial connection.
- **`ClientLogic.find_leader(self)`**: Iterates through its known list of brokers, calling `/metadata/leader` on each until it gets a successful response.
- **`ClientLogic.resilient_request(self, ...)`**: The core of the client's resilience. When a request fails with a connection error, it assumes the leader is dead. It then enters a **patient loop**: it waits for 2 seconds, calls `find_leader`, and if the leader it finds is the same one that just failed, it knows the failover is still in progress and waits again. It only retries the original request once a *new* leader is discovered.
</details>

<details>
<summary><b><code>producer.py</code> & <code>consumer.py</code></b></summary>

These are the runnable applications. They are very simple wrappers around the `ClientLogic`.
- **`run_producer()` / `run_consumer()`**: Each function instantiates `ClientLogic` and then sits in a `while True` loop, using the `resilient_request` method to send or receive messages. They are completely unaware of the complexities of failover, as the logic is fully encapsulated in the `ClientLogic` class.
</details>

### The `scripts/` Directory

<details>
<summary><b><code>start_broker_1.sh</code> & <code>start_broker_2.sh</code></b></summary>

Simple shell scripts to launch the brokers with the correct arguments.
- They pass the broker's ID, its own address, and its peer's address to `broker/main.py`.
- They include the `-u` flag (`python3 -u ...`), which is **critical** for disabling output buffering. This ensures `print` statements appear in the terminal in real-time.
</details>

---

## **5. Local Setup and Demonstration Guide**

### Prerequisites
*   **Python 3.7+** & `pip`
*   **Git** for cloning the repository.
*   A running **Redis** instance on `localhost:6379`. (Easiest with Docker: `docker run --name yak-redis -d -p 6379:6379 redis`)

### Installation Commands
```bash
# 1. Install Python dependencies
pip install -r requirements.txt

# 2. Make the startup scripts executable
chmod +x scripts/start_broker_1.sh
chmod +x scripts/start_broker_2.sh
```

### Running the 4-Terminal Demo
You need **four separate terminal windows** open in the `yak-project` directory.

#### **Terminal 1: Start Broker 1 (Initial Leader)**
```bash
./scripts/start_broker_1.sh
```
**Expected Output:** You will see logs indicating it has become the leader and is renewing its lease.

#### **Terminal 2: Start Broker 2 (Follower)**
```bash
./scripts/start_broker_2.sh
```
**Expected Output:** It will be quiet, only showing logs when it receives replicated messages.

#### **Terminal 3: Run the Producer**
```bash
python3 -m client.producer
```
**Expected Output:** "Leader found..." followed by a stream of "Successfully sent message..." logs.

#### **Terminal 4: Run the Consumer**
```bash
python3 -m client.consumer
```
**Expected Output:** "Leader found..." followed by a stream of "Consumed message..." logs.

### Simulating the Leader Crash: The Main Event
1.  **Action:** Go to **Terminal 1** (Broker 1) and press **`Ctrl+C`** to kill it.
2.  **Observe:** Watch the other three terminals. The logs will tell the story of the failover in real-time. You have now demonstrated a full failover with zero data loss.

---

## **6. Distributed Setup with ZeroTier**

### What is ZeroTier and Why Use It?
ZeroTier creates a secure, virtual LAN for your devices, no matter where they are. It gives each machine a private IP address, saving us the enormous hassle of dealing with public IPs, firewalls, and port forwarding.

### Prerequisites for Distributed Setup
*   **2 to 4 different machines** (Cloud VMs, laptops, etc.).
*   Each machine must have the project code, Python, and dependencies installed.
*   **One machine** must be designated to run Redis.
*   A free [ZeroTier Account](https://my.zerotier.com/).

### Step 1: Create and Configure a ZeroTier Network
1.  **Create Network:** Log in to ZeroTier and click "Create A Network". You will be given a 16-character **Network ID**.
2.  **Install & Join on ALL Machines:** On each machine, install the client and join the network.
    ```bash
    # Install
    curl -s https://install.zerotier.com | sudo bash
    # Join
    sudo zerotier-cli join <Your_Network_ID>
    ```
3.  **Authorize Members:** In your ZeroTier dashboard, **check the "Auth?" box** for each machine.
4.  **Get IP Addresses:** After a moment, each machine will be assigned a "Managed IP". Note these down. Example:
    *   **Machine A (Redis + Broker 1):** `10.147.17.1`
    *   **Machine B (Broker 2):** `10.147.17.2`
    *   **Machine C (Client):** `10.147.17.3`

### Step 2: Configure the YAK Project for the Network

#### **1. Configure Broker Startup Scripts**
On **Machine A**, edit `scripts/start_broker_1.sh`:
```bash
python3 -u -m broker.main 1 10.147.17.1:5001 10.147.17.2:5002
```
On **Machine B**, edit `scripts/start_broker_2.sh`:
```bash
python3 -u -m broker.main 2 10.147.17.2:5002 10.147.17.1:5001
```

#### **2. Configure Redis Host**
On **both Machine A and B**, edit `broker/config.py` to point to Machine A:
```python
REDIS_HOST = '10.147.17.1'
```

#### **3. Configure Clients**
On **Machine C**, edit `client/producer.py` and `client/consumer.py`:
```python
BROKERS = ["http://10.147.17.1:5001", "http://10.147.17.2:5002"]
```

### Step 3: Run the Distributed Demonstration
1.  **On Machine A:** Start Redis, then run `./scripts/start_broker_1.sh`.
2.  **On Machine B:** Run `./scripts/start_broker_2.sh`.
3.  **On Machine C:** Run `python3 -m client.producer` and `python3 -m client.consumer` (in separate terminals).
4.  **Simulate Failure:** Kill the broker on Machine A. Observe as the system heals across the network.

---

## **7. The Failover Sequence: A Microsecond Breakdown**

| Timestamp | Component | Action & State |
| :--- | :--- | :--- |
| **T=0s** | Broker 1 | Process is killed. Stops renewing Redis lease set at T=-5s. |
| **T=2s** | Producer | Tries `POST /produce` to Broker 1. | TCP connection refused. |
| **T=2.1s**| Producer | `resilient_request` catches exception. Prints "Assuming leader is down." | `self.leader` is now `None`. |
| **T=4s** | Producer | Patient loop wakes up. Asks Broker 2 for leader. | Lease in Redis for Broker 1 is **still valid**. |
| **T=4.1s**| Producer | Discovers leader is still Broker 1. Prints "Waiting for failover..." | Goes back to sleep. |
| **T=5s** | Redis | The 10s lease for Broker 1 expires. | `yak:leader_lease` key is auto-deleted. |
| **T=5.5s**| Broker 2 | Checks Redis, sees lease key is gone. | - |
| **T=5.51s**| Broker 2 | Runs `SETNX`. **Succeeds**. | Prints "Promoting to LEADER". `self.role` is now `leader`. |
| **T=6s** | Producer | Patient loop wakes up again. Asks Broker 2 for leader. | Broker 2 reports itself as leader. |
| **T=6.1s**| Producer | Discovers a *new* leader. Retries the failed request to Broker 2. | - |
| **T=6.2s**| Broker 2 | Receives request. Fails to replicate to dead Broker 1. Prints one-time error. | Marks Broker 1 as unhealthy. |
| **T=6.3s**| Broker 2 | Proceeds, updates HWM, returns `200 OK` to Producer. | **Normal operation has resumed.** |
