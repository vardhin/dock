<script>
    import { onMount } from "svelte";
    import Gun from 'gun/gun';
    import { writable } from 'svelte/store';

    const gun = Gun({
        peers: ['https://gun-manhattan.herokuapp.com/gun']
    }); // Connect to local and public Gun peers
    let availableHosts = [];
    let selectedHostKey = "";
    let selectedResources = { cpus: 1, ram: 1 }; // RAM in GBs
    let code = "";
    let file = null;
    let output = "";
    let status = "";

    const NETWORK_ROOM_ID = 'networkroomid';
    let executionRequests = null;

    let inputMode = 'code'; // Add this near your other state variables

    // Add clientId to state variables
    let clientId = "";

    // Add this function to handle Excel download
    function downloadResourcesAsExcel() {
        const csvContent = `Resource,Value\nCPUs,${selectedResources.cpus}\nRAM (GB),${selectedResources.ram}`;
        const blob = new Blob([csvContent], { type: 'text/csv' });
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'selected_resources.csv';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        window.URL.revokeObjectURL(url);
    }

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

        if (!clientId.trim()) {
            alert("Please enter a client ID.");
            return;
        }

        // Find selected host's hostname
        const selectedHost = availableHosts.find(h => h.key === selectedHostKey);
        if (!selectedHost) {
            console.error('Selected host not found in available hosts');
            return;
        }

        console.log('Selected host:', selectedHost);

        const requestData = {
            code: code,
            resources: {
                cpus: parseInt(selectedResources.cpus),
                ram: Math.round(parseFloat(selectedResources.ram) * 1024 ** 3)
            },
            clientId,
            timestamp: Date.now(),
            processed: false
        };

        console.log('Sending request data:', requestData);

        // Send execution request to the selected host's node
        gun.get(selectedHost.host).put(requestData, (ack) => {
            if (ack.err) {
                console.error('Error sending request:', ack.err);
            } else {
                console.log('Request sent successfully');
            }
        });

        // Initialize status and output
        status = 'pending';
        output = '';

        console.log('Listening for updates on clientId:', clientId);

        // Listen for status and output updates with improved logging
        gun.get(clientId).on((data, key) => {
            console.log('Received update on clientId:', clientId);
            console.log('Update data:', data);
            console.log('Update key:', key);

            if (data) {
                if (data.status) {
                    status = data.status;
                    console.log(`Status updated to: ${status}`);
                }
                if (data.output) {
                    output = data.output;
                    console.log(`Output received: ${output}`);
                }
            }
        });
    }

    function handleFileUpload(event) {
        file = event.target.files[0];
        code = "";
    }
</script>

<div class="container">
    <h1>Decentralized Python Code Runner</h1>

    <div class="grid">
        <div class="host-selection">
            <h2>Select Host</h2>
            {#if availableHosts.length > 0}
                <select bind:value={selectedHostKey} class="select">
                    <option value="" disabled>Select a host</option>
                    {#each availableHosts as host}
                        <option value={host.key}>{host.host}</option>
                    {/each}
                </select>
            {:else}
                <p class="no-hosts">No available hosts found</p>
            {/if}

            {#if selectedHostKey}
                <div class="host-info">
                    <h3>Host Resources</h3>
                    {#each availableHosts as host}
                        {#if host.key === selectedHostKey}
                            <div class="resource-cards">
                                <div class="card">
                                    <span class="card-label">CPUs</span>
                                    <span class="card-value">{host.cpus}</span>
                                </div>
                                <div class="card">
                                    <span class="card-label">RAM</span>
                                    <span class="card-value">{(host.ram / (1024 ** 3)).toFixed(2)} GB</span>
                                </div>
                                <div class="card">
                                    <span class="card-label">GPUs</span>
                                    <span class="card-value">{host.gpus.length > 0 ? host.gpus.map(gpu => gpu.name).join(', ') : 'None'}</span>
                                </div>
                            </div>
                        {/if}
                    {/each}
                </div>
            {/if}
        </div>

        <div class="resource-selection">
            <h2>Select Resources</h2>
            <div class="resource-inputs">
                <label>
                    CPUs
                    <input 
                        type="number" 
                        min="1" 
                        bind:value={selectedResources.cpus} 
                        required
                    />
                </label>
                <label>
                    RAM (GB)
                    <input 
                        type="number" 
                        min="0.5" 
                        step="0.1" 
                        bind:value={selectedResources.ram} 
                        required
                    />
                </label>
            </div>
            <button class="download-button" on:click={downloadResourcesAsExcel}>
                Download Resources as CSV
            </button>
        </div>
    </div>

    <div class="client-id-section">
        <h2>Client ID</h2>
        <input 
            type="text" 
            bind:value={clientId} 
            placeholder="Enter your client ID"
            required
        />
    </div>

    <div class="code-section">
        <h2>Python Code</h2>
        <div class="input-mode-toggle">
            <label>
                <input type="radio" bind:group={inputMode} value="code">
                Write Code
            </label>
            <label>
                <input type="radio" bind:group={inputMode} value="file">
                Upload File
            </label>
        </div>

        <div class="code-input">
            {#if inputMode === 'code'}
                <textarea 
                    bind:value={code} 
                    rows="10" 
                    placeholder="Enter your Python code here..." 
                    class="code-editor"
                ></textarea>
            {:else}
                <div class="file-upload">
                    <input type="file" accept=".py" on:change={handleFileUpload} />
                    {#if file}
                        <p class="file-name">Selected file: {file.name}</p>
                    {/if}
                </div>
            {/if}
        </div>
        
        <button class="run-button" on:click={submitCode}>
            Run Code
        </button>
    </div>

    {#if status || output}
        <div class="output-section">
            {#if status}
                <div class="status">
                    Status: <span class={status}>{status}</span>
                </div>
            {/if}
            
            {#if output}
                <h2>Output</h2>
                <pre class="output">{output}</pre>
            {/if}
        </div>
    {/if}
</div>

<style>
    .container {
        max-width: 1200px;
        margin: 0 auto;
        padding: 2rem;
    }

    .grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
        gap: 2rem;
        margin-bottom: 2rem;
    }

    h1 {
        color: #2d3748;
        margin-bottom: 2rem;
        font-size: 2.5rem;
    }

    h2 {
        color: #4a5568;
        margin-bottom: 1rem;
        font-size: 1.5rem;
    }

    .select, input, .code-editor {
        width: 100%;
        padding: 0.75rem;
        border: 2px solid #e2e8f0;
        border-radius: 0.5rem;
        background: white;
        transition: border-color 0.2s, box-shadow 0.2s;
    }

    .select:focus, input:focus, .code-editor:focus {
        outline: none;
        border-color: #4299e1;
        box-shadow: 0 0 0 3px rgba(66, 153, 225, 0.2);
    }

    .resource-cards {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
        gap: 1rem;
        margin-top: 1rem;
    }

    .card {
        background: #f7fafc;
        padding: 1rem;
        border-radius: 0.5rem;
        box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    }

    .card-label {
        display: block;
        color: #718096;
        font-size: 0.875rem;
        margin-bottom: 0.5rem;
    }

    .card-value {
        display: block;
        font-size: 1.25rem;
        font-weight: 600;
        color: #2d3748;
    }

    .code-editor {
        font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
        min-height: 300px;
        margin-bottom: 1rem;
        background: #f8f9fa;
    }

    .run-button {
        background: #4299e1;
        color: white;
        padding: 0.75rem 2rem;
        border: none;
        border-radius: 0.5rem;
        font-weight: 600;
        cursor: pointer;
        transition: background-color 0.2s;
    }

    .run-button:hover {
        background: #3182ce;
    }

    .output {
        background: #1a202c;
        color: #e2e8f0;
        padding: 1.5rem;
        border-radius: 0.5rem;
        overflow-x: auto;
    }

    .status {
        margin-bottom: 1rem;
        font-weight: 600;
    }

    .status .pending {
        color: #d69e2e;
    }

    .status .completed {
        color: #38a169;
    }

    .status .error {
        color: #e53e3e;
    }

    .no-hosts {
        color: #718096;
        font-style: italic;
    }

    .resource-inputs {
        display: grid;
        gap: 1rem;
    }

    .file-upload {
        margin-top: 1rem;
        padding: 1rem;
        background: #f7fafc;
        border-radius: 0.5rem;
    }

    .output-section {
        margin-top: 2rem;
        padding: 1.5rem;
        background: #f7fafc;
        border-radius: 0.5rem;
    }

    .input-mode-toggle {
        margin-bottom: 1rem;
        display: flex;
        gap: 2rem;
    }

    .input-mode-toggle label {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        cursor: pointer;
    }

    .download-button {
        margin-top: 1rem;
        background: #48bb78;
        color: white;
        padding: 0.5rem 1rem;
        border: none;
        border-radius: 0.5rem;
        cursor: pointer;
        transition: background-color 0.2s;
    }

    .download-button:hover {
        background: #38a169;
    }

    .file-name {
        margin-top: 0.5rem;
        color: #4a5568;
        font-size: 0.875rem;
    }
</style>