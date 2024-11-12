const express = require("express");
const multer = require("multer");
const fs = require("fs").promises;
const Docker = require("dockerode");
const docker = new Docker();
const upload = multer();
const Gun = require('gun');
const os = require('os');
const { exec } = require('child_process');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

// Generate a unique host ID
const HOST_ID = uuidv4();

// Create Express App
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Initialize Gun with public peers
const server = app.listen(3000, () => console.log("Server running on http://localhost:3000"));
const gun = Gun({
    web: server,
    peers: [
        'https://gun-manhattan.herokuapp.com/gun'
    ]
});

// Function to get GPU information (supports both NVIDIA and AMD GPUs)
function getGPUInfo() {
    return new Promise((resolve) => {
        // First try NVIDIA GPUs
        exec('nvidia-smi --query-gpu=name,memory.total --format=csv,noheader', (nvidiaError, nvidiaStdout) => {
            if (!nvidiaError) {
                const gpus = nvidiaStdout.trim().split('\n').map(line => {
                    const [name, memory] = line.split(',').map(s => s.trim());
                    return { name, memory, type: 'NVIDIA' };
                });
                return resolve(gpus);
            }

            // If NVIDIA fails, try AMD GPUs
            exec('rocm-smi --showproductname --showmeminfo vram', (amdError, amdStdout) => {
                if (amdError) {
                    console.error("No GPU info available:", amdError);
                    return resolve([]);
                }

                try {
                    const lines = amdStdout.trim().split('\n');
                    const gpus = [];
                    let currentGpu = {};

                    lines.forEach(line => {
                        if (line.includes('GPU')) {
                            if (currentGpu.name) {
                                gpus.push(currentGpu);
                            }
                            currentGpu = { type: 'AMD' };
                        } else if (line.includes('Product Name')) {
                            currentGpu.name = line.split(':')[1].trim();
                        } else if (line.includes('VRAM')) {
                            currentGpu.memory = line.split(':')[1].trim();
                        }
                    });

                    if (currentGpu.name) {
                        gpus.push(currentGpu);
                    }

                    resolve(gpus);
                } catch (parseError) {
                    console.error("Error parsing AMD GPU info:", parseError);
                    resolve([]);
                }
            });
        });
    });
}

// Function to get system resources
async function getSystemResources() {
    const cpus = os.cpus().length;
    const ram = os.totalmem();
    const gpus = await getGPUInfo();
    return { cpus, ram, gpus };
}

// Function to broadcast resources
async function broadcastResources() {
    const resources = await getSystemResources();
    console.log('Broadcasting resources:', {
        hostname: os.hostname(),
        resources: resources
    });

    gun.get(os.hostname()).put({
        host: os.hostname(),
        cpus: resources.cpus,
        ram: resources.ram,
        gpuList: JSON.stringify(resources.gpus),
        timestamp: Date.now(),
    }, (ack) => {
        if (ack.err) {
            console.error('Error broadcasting resources:', ack.err);
        } else {
            console.log('Successfully broadcasted resources');
        }
    });
}

// Broadcast resources every 5 seconds
setInterval(broadcastResources, 5000);

// Listen to execution requests for this host
gun.get(os.hostname()).on(async (request) => {
    console.log('Received data on hostname:', os.hostname());
    console.log('Request data:', JSON.stringify(request, null, 2));

    // Early validation checks
    if (!request || !request.requestId || request.processed || !request.code || !request.clientId) {
        console.log('Invalid or already processed request, skipping');
        return;
    }

    // Check if the requestId has already been processed
    const processedRequests = await gun.get('processedRequests').get(request.requestId).once();
    if (processedRequests) {
        console.log(`Request with ID ${request.requestId} has already been processed. Skipping execution.`);
        return;
    }

    // Mark request as processed immediately to prevent re-execution
    gun.get(os.hostname()).put({
        ...request,
        processed: true
    }, (ack) => {
        if (ack.err) {
            console.error('Error marking request as processed:', ack.err);
            return;
        }
        console.log('Successfully marked request as processed');
    });

    // Store the processed requestId
    gun.get('processedRequests').get(request.requestId).put(true, (ack) => {
        if (ack.err) {
            console.error('Error storing processed requestId:', ack.err);
        } else {
            console.log(`Stored processed requestId: ${request.requestId}`);
        }
    });

    console.log(`Processing execution request for clientId: ${request.clientId}`);

    const { code, clientId, resources } = request;
    const cpus = resources?.cpus || 1;
    const ram = (resources?.ram || 512 * 1024 * 1024);

    console.log(`Configuration: CPUs=${cpus}, RAM=${ram} bytes`);

    try {
        // Create client node for updates
        const clientNode = gun.get(clientId);
        console.log(`Created client node for ID: ${clientId}`);
        
        // Update status to 'running'
        clientNode.put({
            status: 'running',
            timestamp: Date.now()
        }, (ack) => {
            if (ack.err) {
                console.error('Error updating running status:', ack.err);
            } else {
                console.log('Successfully updated status to running');
            }
        });

        // Generate a unique temporary file path
        const uniqueId = uuidv4();
        const filePath = path.join(os.tmpdir(), `code_${uniqueId}.py`);

        // Save the code to a unique temporary file
        await fs.writeFile(filePath, code, { encoding: 'utf8' });
        console.log(`Code written to temporary file: ${filePath}`);

        // Configure Docker resources
        const container = await docker.createContainer({
            Image: "python:alpine", // Updated to Python 3.9 for better compatibility
            Cmd: ["python3", "/app/code.py"],
            AttachStdout: true,
            AttachStderr: true,
            HostConfig: {
                Memory: ram,
                NanoCPUs: cpus * 1e9, // Docker expects CPU quota in nano CPUs
                Binds: [`${filePath}:/app/code.py:ro`], // Mounted as read-only
            },
        });

        console.log(`Docker container created: ${container.id}`);

        await container.start();
        console.log(`Docker container started: ${container.id}`);

        // Capture logs with improved handling
        const logsStream = await container.logs({ stdout: true, stderr: true, follow: true });
        let output = "";

        logsStream.on("data", data => {
            output += data.toString();
            console.log('Received output chunk:', data.toString());
        });

        // Wait for container completion
        const waitResult = await container.wait();
        console.log('Container wait result:', waitResult);

        // Update status and output on completion
        console.log('Sending final output to client:', output);
        
        clientNode.put({
            status: 'completed',
            output: output,
            timestamp: Date.now()
        }, (ack) => {
            if (ack.err) {
                console.error('Error sending final output:', ack.err);
            } else {
                console.log('Successfully sent final output to client');
            }
        });

        // After execution, set up a periodic update for the client
        const updateInterval = setInterval(() => {
            const clientNode = gun.get(clientId);
            clientNode.once((data) => {
                if (data.status === 'completed' || data.status === 'error') {
                    clearInterval(updateInterval);
                } else {
                    clientNode.put({
                        status: data.status,
                        output: data.output,
                        timestamp: Date.now()
                    });
                }
            });
        }, 1000); // Update every second

        // After obtaining the output
        const outputData = {
            status: 'completed',
            output: output,
            timestamp: Date.now()
        };

        // Store the output data associated with requestId
        gun.get('requestOutputs').get(request.requestId).put(outputData, (ack) => {
            if (ack.err) {
                console.error('Error storing output data:', ack.err);
            } else {
                console.log(`Stored output data for requestId: ${request.requestId}`);
            }
        });

        // Function to start output signaling
        function startOutputSignaling(clientId, output) {
            const intervalId = setInterval(() => {
                gun.get(clientId).put({
                    output: output,
                    timestamp: Date.now(),
                }, (ack) => {
                    if (ack.err) {
                        console.error('Error sending output update to client:', ack.err);
                    } else {
                        console.log('Sent output update to client');
                    }
                });
            }, 3000); // Every 3 seconds

            return intervalId;
        }

        // Start signaling
        const outputInterval = startOutputSignaling(request.clientId, outputData.output);

        // Listen for new unique requests to stop signaling
        gun.get(os.hostname()).on(async (newRequest) => {
            if (newRequest.clientId === request.clientId && newRequest.requestId !== request.requestId) {
                clearInterval(outputInterval);
                console.log('Detected new unique request. Stopped previous output signaling.');
            }
        });

        // After processing a new request
        gun.get(request.clientId).put({
            newRequestReceived: true,
            timestamp: Date.now(),
        }, (ack) => {
            if (ack.err) {
                console.error('Error setting newRequestReceived flag:', ack.err);
            } else {
                console.log('Set newRequestReceived flag for client');
            }
        });

    } catch (error) {
        console.error('Execution error:', error);
        console.error('Error stack:', error.stack);

        // Update status to error
        const clientNode = gun.get(clientId);
        clientNode.put({
            status: 'error',
            output: `Error: ${error.message}`,
            timestamp: Date.now()
        }, (ack) => {
            if (ack.err) {
                console.error('Error sending error status:', ack.err);
            } else {
                console.log('Successfully sent error status to client');
            }
        });

        // Mark request as processed
        gun.get(os.hostname()).put({
            ...request,
            processed: true
        }, (ack) => {
            if (ack.err) {
                console.error('Error marking error request as processed:', ack.err);
            } else {
                console.log('Successfully marked error request as processed');
            }
        });

    }
});

// Optional: Implement the /run-code endpoint if needed
app.post("/run-code", upload.single("file"), async (req, res) => {
    let code = req.body.code;

    // Generate a unique temporary file path
    const uniqueId = uuidv4();
    const filePath = path.join(os.tmpdir(), `code_${uniqueId}.py`);

    try {
        // Save the code to a unique temporary file
        if (req.file) {
            await fs.writeFile(filePath, req.file.buffer.toString(), { encoding: 'utf8' });
        } else if (code) {
            await fs.writeFile(filePath, code, { encoding: 'utf8' });
        } else {
            return res.status(400).send({ output: "No code provided" });
        }

        console.log(`Code written to temporary file: ${filePath}`);

        // Create and start the Docker container
        const container = await docker.createContainer({
            Image: "python:alpine",
            Cmd: ["python3", "/app/code.py"],
            AttachStdout: true,
            AttachStderr: true,
            HostConfig: {
                Memory: 4 * 1024 * 1024 * 1024, // 4GB RAM
                NanoCPUs: 4 * 1e9,              // 4 CPUs
                Binds: [`${filePath}:/app/code.py:ro`], // Mounted as read-only
            },
        });

        console.log(`Docker container created: ${container.id}`);

        await container.start();
        console.log(`Docker container started: ${container.id}`);

        // Capture logs
        const logsStream = await container.logs({ stdout: true, stderr: true, follow: true });
        let output = "";

        logsStream.on("data", data => {
            output += data.toString();
        });

        // Wait for the container to finish execution
        await container.wait();
        console.log(`Docker container execution completed: ${container.id}`);

        await container.remove();
        console.log(`Docker container removed: ${container.id}`);

        // Clean up the temporary file
        try {
            await fs.unlink(filePath);
            console.log(`Temporary file deleted: ${filePath}`);
        } catch (unlinkError) {
            if (unlinkError.code === 'ENOENT') {
                console.warn(`Temporary file not found for deletion: ${filePath}`);
            } else {
                console.error(`Error deleting temporary file: ${unlinkError.message}`);
            }
        }

        res.send({ output });

    } catch (error) {
        console.error(`Error during /run-code execution: ${error.message}`);

        // Clean up the temporary file if it exists
        try {
            await fs.unlink(filePath);
            console.log(`Temporary file deleted after error: ${filePath}`);
        } catch (unlinkError) {
            if (unlinkError.code === 'ENOENT') {
                console.warn(`Temporary file not found for deletion after error: ${filePath}`);
            } else {
                console.error(`Error deleting temporary file after error: ${unlinkError.message}`);
            }
        }

        res.status(500).send({ output: error.message });
    }
});

