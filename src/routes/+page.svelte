<script>
    import { onMount } from "svelte";
    let code = "";
    let file;
    let output = "";

    // Submit code to backend
    async function submitCode() {
        let formData = new FormData();
        if (file) {
            formData.append("file", file);
        } else {
            formData.append("code", code);
        }

        const response = await fetch("http://localhost:3000/run-code", {
            method: "POST",
            body: formData,
        });

        const data = await response.json();
        output = data.output;
    }

    function handleFileUpload(event) {
        file = event.target.files[0];
        code = "";
    }
</script>

<h1>Run Python Code in Docker</h1>
<div>
    <label for="code">Enter Python Code:</label>
    <textarea bind:value={code} rows="10" cols="50" placeholder="Enter your Python code here..."></textarea>
</div>

<div>
    <label for="file">Or upload a Python file:</label>
    <input type="file" accept=".py" on:change={handleFileUpload} />
</div>

<button on:click={submitCode}>Run Code</button>

<h2>Output:</h2>
<pre>{output}</pre>

<style>
    h1, h2 {
        color: #333;
    }
    textarea, input {
        display: block;
        margin: 10px 0;
    }
    pre {
        background: #f4f4f4;
        padding: 10px;
    }
</style>
