<script>
    import { onMount } from "svelte";
    import Gun from 'gun/gun';
    import { writable } from 'svelte/store';

    const gun = Gun(['http://localhost:3000/gun', 'https://gun-manhattan.herokuapp.com/gun']); // Connect to local and public Gun peers
    let availableHosts = [];
    let selectedHostKey = "";
    let selectedResources = { cpus: 1, ram: 1 }; // RAM in GBs
    let code = "";
    let file = null;
    let output = "";
    let status = "";

    const NETWORK_ROOM_ID = 'networkroomid';
    let executionRequests = null;

    // Listen to network room and update available hosts
    onMount(() => {
        gun.get(NETWORK_ROOM_ID).map().on((data, key) => {
            if (data && data.host) {
                const parsedGpuList = JSON.parse(data.gpuList || '[]');
                const updatedHosts = availableHosts.filter(h => h.key !== key);
                updatedHosts.push({ key, host: data.host, cpus: data.cpus, ram: data.ram, gpus: parsedGpuList });
                availableHosts = updatedHosts;
            }
        });
    });

    // Submit code to selected host via Gun
    async function submitCode() {
        if (!selectedHostKey) {
            alert("Please select a host.");
            return;
        }

        let codeContent = code;
        if (file) {
            try {
                codeContent = await file.text();
            } catch (err) {
                alert("Failed to read the uploaded file.");
                console.error(err);
                return;
            }
        }

        if (!codeContent.trim()) {
            alert("No code provided.");
            return;
        }

        const clientRoomId = `clientroom_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const requestData = {
            code: codeContent,
            resources: {
                cpus: parseInt(selectedResources.cpus),
                ram: Math.round(parseFloat(selectedResources.ram) * 1024 ** 3) // Convert GB to bytes
            },
            clientRoomId,
            timestamp: Date.now(),
            processed: false
        };

        // Send execution request to the selected host's execution room
        const EXECUTION_ROOM = `executionRequests_${selectedHostKey}`;
        gun.get(EXECUTION_ROOM).set(requestData);
        console.log(`Execution request sent to room: ${EXECUTION_ROOM}`, requestData);

        // Initialize status and output
        status = 'pending';
        output = '';

        // Listen for status and output updates
        gun.get(clientRoomId).on(data => {
            if (data && data.status) {
                status = data.status;
                console.log(`Status updated to: ${status}`);
            }
            if (data && data.output) {
                output = data.output;
                console.log(`Output received: ${output}`);
            }
        });
    }

    function handleFileUpload(event) {
        file = event.target.files[0];
        code = "";
    }
</script>

<h1>Run Python Code in Docker</h1>

<div>
    <h2>Select Host</h2>
    {#if availableHosts.length > 0}
        <select bind:value={selectedHostKey}>
            <option value="" disabled>Select a host</option>
            {#each availableHosts as host}
                <option value={host.key}>{host.host}</option>
            {/each}
        </select>
    {:else}
        <p>No available hosts found.</p>
    {/if}
</div>

{#if selectedHostKey}
    <div>
        <h2>Host Resources</h2>
        {#each availableHosts as host}
            {#if host.key === selectedHostKey}
                <ul>
                    <li><strong>CPUs:</strong> {host.cpus}</li>
                    <li><strong>RAM:</strong> {(host.ram / (1024 ** 3)).toFixed(2)} GB</li>
                    <li><strong>GPUs:</strong> {host.gpus.length > 0 ? host.gpus.map(gpu => gpu.name).join(', ') : 'None'}</li>
                </ul>
            {/if}
        {/each}
    </div>
{/if}

<div>
    <h2>Select Resources</h2>
    <label>
        CPUs:
        <input 
            type="number" 
            min="1" 
            bind:value={selectedResources.cpus} 
            required
        />
    </label>
    <label>
        RAM (GB):
        <input 
            type="number" 
            min="0.5" 
            step="0.1" 
            bind:value={selectedResources.ram} 
            required
        />
    </label>
</div>

<div>
    <h2>Enter Python Code</h2>
    <textarea 
        bind:value={code} 
        rows="10" 
        cols="50" 
        placeholder="Enter your Python code here..." 
        disabled={file !== null}
    ></textarea>
</div>

<div>
    <h2>Or Upload a Python File</h2>
    <input type="file" accept=".py" on:change={handleFileUpload} />
</div>

<button on:click={submitCode}>Run Code</button>

{#if status}
    <h2>Status: {status}</h2>
{/if}

{#if output}
    <h2>Output:</h2>
    <pre>{output}</pre>
{/if}

<style>
    h1, h2 {
        color: #333;
    }
    textarea, input, select, button {
        display: block;
        margin: 10px 0;
        padding: 8px;
        font-size: 1rem;
    }
    pre {
        background: #f4f4f4;
        padding: 10px;
        white-space: pre-wrap;
        word-wrap: break-word;
    }
    ul {
        list-style-type: none;
        padding: 0;
    }
    li {
        margin: 5px 0;
    }
    label {
        display: flex;
        align-items: center;
    }
    label > input {
        margin-left: 10px;
        flex: 1;
    }
</style>